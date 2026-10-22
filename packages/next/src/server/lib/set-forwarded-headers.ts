import type { IncomingHttpHeaders, IncomingMessage } from 'http'
import type { TLSSocket } from 'tls'

export function setForwardedHeaders(
  headers: IncomingHttpHeaders,
  request: IncomingMessage | null,
  hostname: string | undefined,
  port: number | undefined
): void {
  const forwardedProto = request?.headers['x-forwarded-proto']
  const isHttps = forwardedProto
    ? forwardedProto === 'https'
    : !!(request?.socket as TLSSocket)?.encrypted

  headers['x-forwarded-host'] ??= headers.host ?? hostname
  headers['x-forwarded-port'] ??= port
    ? port.toString()
    : isHttps
      ? '443'
      : '80'
  headers['x-forwarded-proto'] ??= isHttps ? 'https' : 'http'
  headers['x-forwarded-for'] ??= request?.socket?.remoteAddress
}
