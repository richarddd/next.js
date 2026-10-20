import type { IncomingMessage, ServerResponse } from 'http'
import type { NextConfigComplete, NextConfigRuntime } from '../../config-shared'
import type { FunctionsConfigManifest } from '../../../build'
import type { MiddlewareManifest } from '../../../build/webpack/plugins/middleware-plugin'
import type { FetchEventResult } from '../../web/types'
import type { setupFsCheck } from './filesystem'
import path from 'path'
import {
  FUNCTIONS_CONFIG_MANIFEST,
  MIDDLEWARE_MANIFEST,
  SERVER_DIRECTORY,
} from '../../../shared/lib/constants'
import { filterReqHeaders, ipcForbiddenHeaders } from '../server-ipc/utils'
import { splitCookiesString, toNodeOutgoingHttpHeaders } from '../../web/utils'
import { pipeToNodeResponse } from '../../pipe-readable'
import { signalFromNodeResponse } from '../../web/spec-extension/adapters/next-request'
import {
  searchParamsToUrlQuery,
  urlQueryToSearchParams,
} from '../../../shared/lib/router/utils/querystring'
import { addRequestMeta } from '../../request-meta'

/** What the fast path needs from the NextNodeServer instance. */
export interface ProxyFastPathServerContext {
  fetchHostname?: string
  port?: number
  getWaitUntil: () => ((promise: Promise<any>) => void) | undefined
}

type NodeProxyModule = {
  default: (opts: {
    handler: unknown
    request: unknown
    page: string
  }) => Promise<FetchEventResult>
  proxy?: unknown
  middleware?: unknown
}

// Response headers the generic routing path never forwards from a proxy
// response (see resolve-routes.ts).
const SKIPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'x-middleware-rewrite',
  'x-middleware-redirect',
  'x-middleware-refresh',
  'x-middleware-next',
  'x-middleware-set-cookie',
])

// Response headers that make routing continue after the proxy ran. Those
// responses are handed back to the generic path.
const CONTINUE_ROUTING_HEADERS = [
  'x-middleware-next',
  'x-middleware-rewrite',
  'location',
  'x-middleware-override-headers',
]

/**
 * A fast path for requests that only a Node.js proxy (middleware) handles,
 * used by `next start`.
 *
 * The generic path walks the whole route table in `resolveRoutes`, then calls
 * back into `BaseServer.handleRequest` for a second routing pass that finally
 * runs the proxy, re-requiring its module and manifests several times per
 * request. When the proxy is the first route that can match, none of that is
 * needed: this matches the proxy directly and calls it once.
 *
 * Returns `null` when the app's configuration can't be handled here; those
 * apps keep using the generic path for every request. For individual
 * requests, `handle` returns `false` when the generic path must take over.
 */
export function createProxyFastPath({
  dev,
  minimalMode,
  config,
  fsChecker,
  distDir,
  getServerContext,
}: {
  dev: boolean | undefined
  minimalMode: boolean | undefined
  config: NextConfigComplete | NextConfigRuntime
  fsChecker: Awaited<ReturnType<typeof setupFsCheck>>
  distDir: string
  getServerContext: () => Promise<ProxyFastPathServerContext | undefined>
}): ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | null {
  if (
    dev ||
    minimalMode ||
    config.i18n ||
    config.basePath ||
    config.trailingSlash ||
    config.skipProxyUrlNormalize
  ) {
    return null
  }

  let functionsConfig: FunctionsConfigManifest
  let middlewareManifest: MiddlewareManifest
  try {
    functionsConfig = require(
      path.join(distDir, SERVER_DIRECTORY, FUNCTIONS_CONFIG_MANIFEST)
    )
    middlewareManifest = require(
      path.join(distDir, SERVER_DIRECTORY, MIDDLEWARE_MANIFEST)
    )
  } catch {
    return null
  }

  // Node.js proxies only; Edge middleware keeps the generic path.
  const nodeProxy = functionsConfig.functions['/_middleware']
  if (!nodeProxy || middlewareManifest.middleware['/']) {
    return null
  }

  const matchers = nodeProxy.matchers ?? [
    { regexp: '.*', originalSource: '/:path*' },
  ]
  if (matchers.some((matcher) => matcher.has || matcher.missing)) {
    return null
  }

  // Headers, redirects and beforeFiles rewrites are checked before the proxy.
  // If any of them can match, the request takes the generic path. They're
  // compiled case-insensitively on purpose: matching too much is safe.
  const precedingRoutes: Array<{ regex?: string }> = [
    ...fsChecker.headers,
    ...fsChecker.redirects,
    ...fsChecker.rewrites.beforeFiles,
  ]
  const precedingRegexes: RegExp[] = []
  for (const route of precedingRoutes) {
    if (typeof route.regex !== 'string') {
      // Can't prove it won't match.
      return null
    }
    precedingRegexes.push(new RegExp(route.regex, 'i'))
  }
  const proxyRegexes = matchers.map((matcher) => new RegExp(matcher.regexp))

  const proxyModule = require(
    path.join(distDir, SERVER_DIRECTORY, 'middleware.js')
  ) as NodeProxyModule
  const adapterFn = proxyModule.default
  const proxyHandler =
    proxyModule.proxy || proxyModule.middleware || proxyModule

  const nextConfigForRequest = {
    basePath: config.basePath,
    i18n: config.i18n,
    trailingSlash: config.trailingSlash,
    experimental: config.experimental,
  }

  let serverContext: ProxyFastPathServerContext | undefined

  return async function handleWithProxyFastPath(req, res) {
    const { method, url, headers } = req
    // Bodies need the cloneable-body plumbing of the generic path.
    if (method !== 'GET' && method !== 'HEAD') return false
    if (!url || url.charCodeAt(0) !== 47 /* / */) return false
    if (headers['x-nextjs-data'] || headers['x-prerender-revalidate']) {
      return false
    }

    const queryIndex = url.indexOf('?')
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
    if (
      pathname.startsWith('/_next/') ||
      pathname.includes('//') ||
      pathname.includes('\\') ||
      pathname.includes('%')
    ) {
      return false
    }
    if (precedingRegexes.some((regex) => regex.test(pathname))) return false
    if (!proxyRegexes.some((regex) => regex.test(pathname))) return false

    serverContext ??= await getServerContext()
    if (!serverContext) return false

    // Same request URL as `NextNodeServer.runMiddleware` builds.
    const search = queryIndex === -1 ? '' : url.slice(queryIndex + 1)
    const query = search
      ? urlQueryToSearchParams(
          searchParamsToUrlQuery(new URLSearchParams(search))
        ).toString()
      : ''
    const protocol =
      (req.socket as { encrypted?: boolean } | undefined)?.encrypted ||
      (typeof headers['x-forwarded-proto'] === 'string' &&
        headers['x-forwarded-proto'].includes('https'))
        ? 'https'
        : 'http'

    const result = await adapterFn({
      handler: proxyHandler,
      request: {
        headers,
        method,
        nextConfig: nextConfigForRequest,
        url: `${protocol}://${serverContext.fetchHostname || 'localhost'}:${serverContext.port}${pathname}${query ? `?${query}` : ''}`,
        page: {},
        body: undefined,
        signal: signalFromNodeResponse(res),
        waitUntil: serverContext.getWaitUntil(),
      },
      page: 'middleware',
    })

    result.waitUntil.catch((error) => {
      console.error(`Uncaught: middleware waitUntil errored`, error)
    })

    const { response } = result
    // Same normalization as `NextNodeServer.runMiddleware`.
    if (response.headers.has('set-cookie')) {
      const cookies = response.headers
        .getSetCookie()
        .flatMap((cookie) => splitCookiesString(cookie))
      response.headers.delete('set-cookie')
      for (const cookie of cookies) {
        response.headers.append('set-cookie', cookie)
      }
      addRequestMeta(req, 'middlewareCookie', cookies)
    }

    // Anything that continues routing goes to the generic path with the
    // result attached, so the proxy never runs twice.
    if (CONTINUE_ROUTING_HEADERS.some((name) => response.headers.has(name))) {
      addRequestMeta(req, 'proxyFastPathResult', result)
      return false
    }

    const responseHeaders = filterReqHeaders(
      toNodeOutgoingHttpHeaders(response.headers),
      ipcForbiddenHeaders
    )
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (value && !SKIPPED_RESPONSE_HEADERS.has(key)) {
        res.setHeader(key, value)
      }
    }
    res.statusCode = response.status

    if (response.body) {
      await pipeToNodeResponse(response.body, res)
    } else {
      res.end()
    }
    return true
  }
}
