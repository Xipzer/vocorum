// Small HTTP helpers for the hub's own routes (outside the twin's /api).

import type http from 'node:http'
import zlib from 'node:zlib'
import { HttpError } from './auth.ts'

export const JSON_LIMIT = 1024 * 1024
export const UPLOAD_LIMIT = 25 * 1024 * 1024

export async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new HttpError(413, 'Payload too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'Payload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  const body = await readBody(req, JSON_LIMIT)
  if (body.length === 0) return {} as T
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  endJson(res, status, value === undefined ? '' : JSON.stringify(value), headers)
}

// JSON bodies larger than one packet go out compressed when the client accepts it
// (/client/state is hundreds of KB on a phone). Brotli first, then gzip.
export function endJson(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  const base = { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  const accepts = String(res.req?.headers['accept-encoding'] ?? '')
  const encoding = body.length < 1400 ? null : /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null
  if (!encoding) {
    res.writeHead(status, base)
    res.end(body)
    return
  }
  const done = (error: Error | null, data: Buffer) => {
    if (error) {
      res.writeHead(status, base)
      res.end(body)
      return
    }
    res.writeHead(status, { ...base, 'content-encoding': encoding, vary: 'Accept-Encoding', 'content-length': String(data.length) })
    res.end(data)
  }
  if (encoding === 'br') zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }, done)
  else zlib.gzip(body, { level: 6 }, done)
}

export function sendError(res: http.ServerResponse, error: unknown) {
  if (res.headersSent) {
    res.end()
    return
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message })
    return
  }
  console.error('[hub]', error)
  sendJson(res, 500, { error: 'Internal error' })
}

// Matches "/client/channels/:id/messages" style patterns; returns params or null.
export function match(pattern: string, pathname: string): Record<string, string> | null {
  const a = pattern.split('/')
  const b = pathname.split('/')
  if (a.length !== b.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    const part = a[i]!
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(b[i]!)
    else if (part !== b[i]) return null
  }
  return params
}
