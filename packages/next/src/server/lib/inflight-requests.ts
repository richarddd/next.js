import type { ServerResponse } from 'http'

// Shared through globalThis so the count is the same even if this module is
// loaded more than once (e.g. from a bundled server runtime).
const INFLIGHT_REQUESTS = Symbol.for('next.inflight-requests')

type GlobalWithInflightRequests = typeof globalThis & {
  [INFLIGHT_REQUESTS]?: number
}

const globalState = globalThis as GlobalWithInflightRequests

/**
 * Counts `res` as in flight until it closes or the returned function is
 * called, whichever happens first.
 */
export function trackInflightRequest(res: ServerResponse): () => void {
  globalState[INFLIGHT_REQUESTS] = (globalState[INFLIGHT_REQUESTS] ?? 0) + 1
  let done = false
  const untrack = () => {
    if (done) return
    done = true
    globalState[INFLIGHT_REQUESTS]!--
  }
  res.once('close', untrack)
  return untrack
}

/**
 * Resolves once no request is in flight. Checks after the I/O phase of each
 * event loop iteration, so connections that are already waiting to be read
 * are counted before background work is allowed to continue.
 */
export async function waitForNoInflightRequests(): Promise<void> {
  do {
    await new Promise<void>((resolve) => setImmediate(resolve))
  } while ((globalState[INFLIGHT_REQUESTS] ?? 0) > 0)
}
