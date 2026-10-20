import type { IncomingMessage, ServerResponse } from 'http'
import type { NextConfigComplete, NextConfigRuntime } from '../../config-shared'
import type { FunctionsConfigManifest } from '../../../build'
import type { MiddlewareManifest } from '../../../build/webpack/plugins/middleware-plugin'
import type { FetchEventResult } from '../../web/types'
import type { NextUrlWithParsedQuery } from '../../request-meta'
import type { setupFsCheck } from './filesystem'
import path from 'path'
import {
  FUNCTIONS_CONFIG_MANIFEST,
  MIDDLEWARE_MANIFEST,
  SERVER_DIRECTORY,
} from '../../../shared/lib/constants'
import { ipcForbiddenHeaders } from '../server-ipc/utils'
import { streamToNodeResponse } from '../../pipe-readable'
import { searchParamsToUrlQuery } from '../../../shared/lib/router/utils/querystring'

import { addRequestMeta } from '../../request-meta'

export type ProxyFastPathHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  parsed: Pick<NextUrlWithParsedQuery, 'pathname' | 'query'>
) => Promise<FetchEventResult | { finished: boolean }>

// Match resolve-routes.ts's response-header filtering.
const SKIPPED_RESPONSE_HEADERS = new Set([
  ...ipcForbiddenHeaders,
  'content-length',
  'set-cookie',
  'x-middleware-rewrite',
  'x-middleware-redirect',
  'x-middleware-refresh',
  'x-middleware-next',
  'x-middleware-set-cookie',
])

/**
 * Runs eligible Node.js proxies without a second routing pass.
 * Returns null for unsupported configurations and false to continue routing.
 */
export function createProxyFastPath({
  dev,
  minimalMode,
  config,
  fsChecker,
  distDir,
  getHandler,
}: {
  dev: boolean | undefined
  minimalMode: boolean | undefined
  config: NextConfigComplete | NextConfigRuntime
  fsChecker: Awaited<ReturnType<typeof setupFsCheck>>
  distDir: string
  getHandler: () => Promise<ProxyFastPathHandler | undefined>
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

  // Defer when custom routes might match. Case-insensitive checks err toward
  // the generic path.
  const precedingRoutes: Array<{ regex?: string }> = [
    ...fsChecker.headers,
    ...fsChecker.redirects,
    ...fsChecker.rewrites.beforeFiles,
  ]
  const precedingRegexes: RegExp[] = []
  for (const route of precedingRoutes) {
    if (typeof route.regex !== 'string') {
      return null
    }
    precedingRegexes.push(new RegExp(route.regex, 'i'))
  }
  const proxyRegexes = matchers.map((matcher) => new RegExp(matcher.regexp))

  let handler: ProxyFastPathHandler | undefined

  return async function handleWithProxyFastPath(req, res) {
    const { method, url, headers } = req
    // Bodies need the cloneable-body plumbing of the generic path.
    if (method !== 'GET' && method !== 'HEAD') return false
    if (!url || url.charCodeAt(0) !== 47 /* / */ || url.includes('#'))
      return false
    if (headers['x-nextjs-data'] || headers['x-prerender-revalidate']) {
      return false
    }

    const queryIndex = url.indexOf('?')
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
    if (
      pathname.startsWith('/_next/') ||
      pathname.includes('//') ||
      pathname.includes('\\') ||
      pathname.includes('%') ||
      pathname.includes('/.')
    ) {
      return false
    }
    if (precedingRegexes.some((regex) => regex.test(pathname))) return false
    if (!proxyRegexes.some((regex) => regex.test(pathname))) return false

    handler ??= await getHandler()
    if (!handler) return false

    const result = await handler(req, res, {
      pathname,
      query:
        queryIndex === -1
          ? {}
          : searchParamsToUrlQuery(
              new URLSearchParams(url.slice(queryIndex + 1))
            ),
    })
    if (!('response' in result)) return false

    const { response } = result
    // Reuse the result if routing continues so the proxy runs only once.
    if (
      response.headers.has('x-middleware-next') ||
      response.headers.has('x-middleware-rewrite') ||
      response.headers.has('location') ||
      response.headers.has('x-middleware-override-headers')
    ) {
      addRequestMeta(req, 'proxyFastPathResult', result)
      return false
    }

    response.headers.forEach((value, key) => {
      if (value && !SKIPPED_RESPONSE_HEADERS.has(key)) res.setHeader(key, value)
    })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) {
      res.setHeader('set-cookie', cookies.length === 1 ? cookies[0] : cookies)
    }
    res.statusCode = response.status

    if (response.body) {
      await streamToNodeResponse(response.body, res)
    } else {
      res.end()
    }
    return true
  }
}
