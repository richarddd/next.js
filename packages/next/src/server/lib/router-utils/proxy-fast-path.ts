import type { IncomingMessage, ServerResponse } from 'http'
import type { NextConfigComplete, NextConfigRuntime } from '../../config-shared'
import type { FetchEventResult } from '../../web/types'
import type { ParsedUrl } from '../../../shared/lib/router/utils/parse-url'
import type { setupFsCheck } from './filesystem'
import { ipcForbiddenHeaders } from '../server-ipc/utils'
import { pipeToNodeResponse } from '../../pipe-readable'
import { parseUrl } from '../../../shared/lib/router/utils/parse-url'
import { addRequestMeta } from '../../request-meta'

export type ProxyFastPathHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  parsed: ParsedUrl
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

export function createProxyFastPath({
  dev,
  minimalMode,
  config,
  fsChecker,
  getHandler,
}: {
  dev: boolean | undefined
  minimalMode: boolean | undefined
  config: NextConfigComplete | NextConfigRuntime
  fsChecker: Awaited<ReturnType<typeof setupFsCheck>>
  getHandler: () => Promise<ProxyFastPathHandler>
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

  const matchers = fsChecker.nodeMiddlewareMatchers
  const matchMiddleware = fsChecker.getMiddlewareMatchers()
  if (
    !matchers ||
    !matchMiddleware ||
    matchers.some((matcher) => matcher.has || matcher.missing)
  ) {
    return null
  }

  const precedingRoutes = [
    ...fsChecker.headers,
    ...fsChecker.redirects,
    ...fsChecker.rewrites.beforeFiles,
  ]

  let handler: ProxyFastPathHandler | undefined

  return async function handleWithProxyFastPath(req, res) {
    const { method, url, headers } = req
    // Bodies need the cloneable-body plumbing of the generic path.
    if (method !== 'GET' && method !== 'HEAD') return false
    if (!url || !url.startsWith('/') || url.includes('#')) return false
    if (headers['x-nextjs-data'] || headers['x-prerender-revalidate']) {
      return false
    }

    const pathname = url.split('?', 1)[0]
    if (
      pathname.startsWith('/_next/') ||
      pathname.includes('//') ||
      pathname.includes('\\') ||
      pathname.includes('%') ||
      pathname.includes('/.')
    ) {
      return false
    }
    const parsed = parseUrl(url)
    if (precedingRoutes.some((route) => route.match(parsed.pathname)))
      return false
    if (!matchMiddleware(parsed.pathname, req, parsed.query)) return false

    handler ??= await getHandler()
    const result = await handler(req, res, parsed)
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
      await pipeToNodeResponse(response.body, res)
    } else {
      res.end()
    }
    return true
  }
}
