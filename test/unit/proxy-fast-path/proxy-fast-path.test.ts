import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'
import path from 'path'
import { createProxyFastPath } from '../../../packages/next/src/server/lib/router-utils/proxy-fast-path'
import { getRequestMeta } from '../../../packages/next/src/server/request-meta'

const distDir = path.join(__dirname, 'fixtures', '.next')
const middlewarePath = path.join(distDir, 'server', 'middleware.js')
const adapter = jest.fn(
  async (_options: {
    request: { headers: IncomingMessage['headers']; url: string }
  }) => ({
    response: new Response(null, { status: 204 }),
    waitUntil: Promise.resolve(),
  })
)

function createHandler(module: unknown = { default: adapter }) {
  jest.doMock(
    path.join(distDir, 'server', 'functions-config-manifest.json'),
    () => ({
      functions: { '/_middleware': { matchers: [{ regexp: '^/.*$' }] } },
    }),
    { virtual: true }
  )
  jest.doMock(
    path.join(distDir, 'server', 'middleware-manifest.json'),
    () => ({ middleware: {} }),
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
      headers: [],
      redirects: [{ regex: '^/blocked/?$' }],
      rewrites: { beforeFiles: [] },
    } as unknown as Parameters<typeof createProxyFastPath>[0]['fsChecker'],
    distDir,
    getServerContext: async () => ({
      hostname: '::1',
      fetchHostname: '[::1]',
      port: 3000,
      getWaitUntil: () => undefined,
    }),
  })!
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
  for (const url of ['/_next/static/chunk.js', '/blocked']) {
    expect(await handle(request(url), response())).toBe(false)
  }
  expect(adapter).not.toHaveBeenCalled()
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
