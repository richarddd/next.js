import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { IncomingMessage, ServerResponse } from 'http'
import path from 'path'
import { createProxyFastPath } from 'next/dist/server/lib/router-utils/proxy-fast-path'
import { addRequestMeta, getRequestMeta } from 'next/dist/server/request-meta'
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import {
  NodeNextRequest,
  NodeNextResponse,
} from 'next/dist/server/base-http/node'

const NextNodeServer = require('next/dist/server/next-server').default

const distDir = path.join(__dirname, 'fixtures', '.next')
const middlewarePath = path.join(distDir, 'server', 'middleware.js')
const adapter = jest.fn(
  async (_options: {
    request: {
      headers: IncomingMessage['headers']
      url: string
      body?: unknown
    }
  }) => ({
    response: new Response(null, { status: 204 }),
    waitUntil: Promise.resolve(),
  })
)

function createHandler(
  module: unknown = { default: adapter },
  prepare = async () => {},
  matchers: Parameters<typeof getMiddlewareRouteMatcher>[0] = [
    { regexp: '^/.*$', originalSource: '/:path*' },
  ],
  nodeMiddleware = true
) {
  jest.doMock(
    path.join(distDir, 'server', 'functions-config-manifest.json'),
    () => ({
      functions: { '/_middleware': { matchers } },
    }),
    { virtual: true }
  )
  jest.doMock(middlewarePath, () => module, { virtual: true })
  return createProxyFastPath({
    dev: false,
    minimalMode: false,
    config: { experimental: {} } as Parameters<
      typeof createProxyFastPath
    >[0]['config'],
    fsChecker: {
      nodeMiddlewareMatchers: nodeMiddleware ? matchers : undefined,
      getMiddlewareMatchers: () => getMiddlewareRouteMatcher(matchers),
      headers: [],
      redirects: [
        { match: getPathMatch('/blocked') },
        { match: getPathMatch('/caf%C3%A9') },
      ],
      rewrites: { beforeFiles: [] },
    } as unknown as Parameters<typeof createProxyFastPath>[0]['fsChecker'],
    getHandler: async () => {
      const server = createServer(prepare)
      return server.getProxyFastPathHandler()
    },
  })!
}

function createServer(prepare = async () => {}) {
  return Object.assign(Object.create(NextNodeServer.prototype), {
    dev: false,
    distDir,
    nextConfig: { experimental: {} },
    renderOpts: { previewProps: { previewModeId: 'test-preview-id' } },
    hostname: '::1',
    fetchHostname: '[::1]',
    port: 3000,
    prepare,
    getWaitUntil: () => undefined,
  })
}

function request(
  url = '/hello',
  headers: IncomingMessage['headers'] = { host: 'example.test' }
) {
  return {
    method: 'GET',
    url,
    headers,
    socket: { remoteAddress: '192.0.2.1' },
  } as IncomingMessage
}

function response() {
  const res = new EventEmitter() as ServerResponse
  res.end = jest.fn()
  res.setHeader = jest.fn()
  return res
}

beforeEach(() => {
  jest.resetModules()
  adapter.mockClear()
})

it.each([
  '/parent/../blocked',
  '/./blocked',
  '/parent/..',
  '/hello?a=x#fragment',
])('keeps URL normalization on the generic path for %s', async (url) => {
  expect(await createHandler()(request(url), response())).toBe(false)
  expect(adapter).not.toHaveBeenCalled()
})

it('does not import proxy code for ineligible or preceding routes', async () => {
  const handle = createHandler()
  jest.doMock(
    middlewarePath,
    () => {
      throw new Error('proxy import failed')
    },
    { virtual: true }
  )
  for (const url of [
    '/_next/static/chunk.js',
    '/blocked',
    '/BLOCKED',
    '/blocked/',
    '/café',
  ]) {
    expect(await handle(request(url), response())).toBe(false)
  }
  expect(adapter).not.toHaveBeenCalled()
})

it('keeps non-Node middleware on the generic path', () => {
  expect(createHandler(undefined, undefined, [], false)).toBeNull()
  expect(adapter).not.toHaveBeenCalled()
})

it.each([
  {
    regexp: '^/.*$',
    originalSource: '/:path*',
    has: [{ type: 'header' as const, key: 'x-only' }],
  },
  {
    regexp: '^/.*$',
    originalSource: '/:path*',
    missing: [{ type: 'header' as const, key: 'x-only' }],
  },
])(
  'keeps conditional middleware matchers on the generic path (%#)',
  (matcher) => {
    expect(createHandler(undefined, undefined, [matcher])).toBeNull()
    expect(adapter).not.toHaveBeenCalled()
  }
)

it('uses the existing URL parser for query values', async () => {
  await createHandler()(request('/hello?a=1&a=2&b=two+words'), response())
  const url = new URL(adapter.mock.calls[0][0].request.url)
  expect(url.searchParams.getAll('a')).toEqual(['1', '2'])
  expect(url.searchParams.get('b')).toBe('two words')
})

it('awaits proxy modules that use top-level await', async () => {
  expect(
    await createHandler(Promise.resolve({ default: adapter }))(
      request(),
      response()
    )
  ).toBe(true)
  expect(adapter).toHaveBeenCalledTimes(1)
})

it('sets the same forwarded-header defaults as the generic path', async () => {
  await createHandler()(request(), response())
  expect(adapter.mock.calls[0][0].request.headers).toMatchObject({
    'x-forwarded-host': 'example.test',
    'x-forwarded-port': '3000',
    'x-forwarded-proto': 'http',
    'x-forwarded-for': '192.0.2.1',
  })
})

it('preserves existing forwarded headers', async () => {
  const headers = {
    host: 'example.test',
    'x-forwarded-host': 'forwarded.test',
    'x-forwarded-port': '443',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '198.51.100.1',
  }
  await createHandler()(request('/hello', { ...headers }), response())
  expect(adapter.mock.calls[0][0].request.headers).toEqual(headers)
})

it('uses the server hostname when Host is absent', async () => {
  await createHandler()(request('/hello', {}), response())
  expect(adapter.mock.calls[0][0].request.headers['x-forwarded-host']).toBe(
    '::1'
  )
})

it('uses the forwarded protocol when it differs from the socket', async () => {
  const req = request('/hello', { 'x-forwarded-proto': 'http' })
  Object.assign(req.socket, { encrypted: true })
  await createHandler()(req, response())
  expect(adapter.mock.calls[0][0].request.url).toBe('http://[::1]:3000/hello')
})

it('retains continuation responses without reading or invoking the proxy twice', async () => {
  const result = {
    response: new Response('body', { headers: { 'x-middleware-next': '1' } }),
    waitUntil: Promise.resolve(),
  }
  adapter.mockResolvedValueOnce(result)
  const req = request()
  expect(await createHandler()(req, response())).toBe(false)
  expect(getRequestMeta(req, 'proxyFastPathResult')).toBe(result)
  expect(result.response.bodyUsed).toBe(false)
  expect(adapter).toHaveBeenCalledTimes(1)
})

it('filters response headers and splits compound cookies without consuming the body', async () => {
  const result = {
    response: new Response(null, {
      status: 204,
      headers: {
        connection: 'close',
        'content-encoding': 'gzip',
        'content-length': '12',
        'x-middleware-refresh': '1',
        empty: '',
        'x-custom': 'value',
        'set-cookie':
          'first=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT, second=2',
      },
    }),
    waitUntil: Promise.resolve(),
  }
  const res = response()
  await createHandler({ default: async () => result })(request(), res)
  expect(res.setHeader).toHaveBeenCalledTimes(2)
  expect(res.setHeader).toHaveBeenCalledWith('x-custom', 'value')
  expect(res.setHeader).toHaveBeenCalledWith('set-cookie', [
    'first=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT',
    'second=2',
  ])
  expect(result.response.bodyUsed).toBe(false)
})

it('prepares the server before importing proxy code and reuses the executor', async () => {
  let registered!: () => void
  const prepare = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        registered = resolve
      })
  )
  const handle = createHandler({ default: adapter }, prepare)
  const load = jest.fn(() => ({ default: adapter }))
  jest.doMock(middlewarePath, load, { virtual: true })
  const pending = handle(request(), response())
  expect(load).not.toHaveBeenCalled()
  registered()
  await pending
  await handle(request(), response())
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(load).toHaveBeenCalledTimes(1)
  expect(adapter).toHaveBeenCalledTimes(2)
})

it.each(['adapter', 'clone'])(
  'finalizes the original POST body when %s throws',
  async (failure) => {
    const server = createServer()
    const req = request()
    req.method = 'POST'
    addRequestMeta(req, 'initProtocol', 'http')
    const stream = new PassThrough()
    const error = new Error('body test')
    const body = {
      cloneBodyStream: jest.fn(() => stream),
      finalize: jest.fn(async () => {}),
    }
    addRequestMeta(req, 'clonableBody', body)
    if (failure === 'clone') {
      body.cloneBodyStream.mockImplementationOnce(() => {
        throw error
      })
    } else {
      adapter.mockImplementationOnce(async ({ request }) => {
        expect(request.body).toBe(stream)
        throw error
      })
    }
    await expect(
      server.runMiddleware({
        request: new NodeNextRequest(req),
        response: new NodeNextResponse(response()),
        parsed: { pathname: '/hello', query: {} },
        nodeMiddleware: { default: adapter },
      })
    ).rejects.toBe(error)
    expect(body.cloneBodyStream).toHaveBeenCalledTimes(1)
    expect(body.finalize).toHaveBeenCalledTimes(1)
    expect(adapter).toHaveBeenCalledTimes(failure === 'clone' ? 0 : 1)
  }
)
