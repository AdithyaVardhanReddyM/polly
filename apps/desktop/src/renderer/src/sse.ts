import type { CoderEvent } from '../../shared/contracts'
import { serverUrl } from './api'

/**
 * Read a server-sent event stream from a POST (or GET) request. `EventSource`
 * is GET-only, so this parses the `event:` / `data:` frames by hand.
 * Resolves when the stream ends; rejects on HTTP errors or when aborted.
 */
export async function stream(
  path: string,
  body: unknown,
  onEvent: (event: CoderEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const url = `${await serverUrl()}${path}`
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const payload = (await res.json()) as { detail?: unknown }
      if (typeof payload.detail === 'string') detail = payload.detail
    } catch {
      /* no JSON body */
    }
    throw new Error(detail)
  }
  if (!res.body) throw new Error('empty response')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut = buffer.indexOf('\n\n')
    while (cut !== -1) {
      const frame = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) {
        try {
          onEvent(JSON.parse(data) as CoderEvent)
        } catch {
          /* a malformed frame is dropped, not fatal */
        }
      }
      cut = buffer.indexOf('\n\n')
    }
  }
}
