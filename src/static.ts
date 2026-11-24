// Serves the built PWA. Unknown paths fall back to index.html (client routing).

import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import type http from 'node:http'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export const SECURITY_HEADERS = {
  'content-security-policy':
    // Outside media only from Discord's CDN and YouTube thumbnails (embeds, custom
    // emoji, stickers), and players only from YouTube's no-cookie host and Vimeo.
    "default-src 'self'; img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https://images-ext-1.discordapp.net https://images-ext-2.discordapp.net https://i.ytimg.com; media-src 'self' blob: https://cdn.discordapp.com https://media.discordapp.net; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

export async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, webDir: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const root = path.resolve(webDir)
  let file = path.resolve(root, `.${decodeURIComponent(pathname)}`)
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(404).end()
    return
  }
  let stat = await fs.promises.stat(file).catch(() => null)
  if (!stat || stat.isDirectory()) {
    file = path.join(root, 'index.html')
    stat = await fs.promises.stat(file).catch(() => null)
  }
  if (!stat) {
    res.writeHead(503, { 'content-type': 'text/plain' }).end('PWA not built: run `pnpm build:web` in hub/')
    return
  }
  const ext = path.extname(file)
  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  const headers = { ...SECURITY_HEADERS, 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' }
  // Text assets (the app bundle is ~500 KB) go out compressed, made once per file version.
  const accepts = String(req.headers['accept-encoding'] ?? '')
  const encoding = COMPRESSIBLE.has(ext) && stat.size > 1400 ? (/\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null) : null
  if (encoding) {
    const body = await compressedFile(file, stat.mtimeMs, encoding)
    res.writeHead(200, { ...headers, 'content-encoding': encoding, vary: 'Accept-Encoding', 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }
  res.writeHead(200, { ...headers, ...(COMPRESSIBLE.has(ext) && { vary: 'Accept-Encoding' }), 'content-length': stat.size })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(file).pipe(res)
}

const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt', '.map'])
const compressedCache = new Map<string, Promise<Buffer>>()

function compressedFile(file: string, mtime: number, encoding: 'br' | 'gzip'): Promise<Buffer> {
  const key = `${encoding}:${mtime}:${file}`
  let cached = compressedCache.get(key)
  if (!cached) {
    cached = fs.promises.readFile(file).then((data) =>
      encoding === 'br' ? promisify(zlib.brotliCompress)(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : promisify(zlib.gzip)(data, { level: 9 }),
    )
    for (const old of compressedCache.keys()) if (old.endsWith(`:${file}`) && old.startsWith(`${encoding}:`)) compressedCache.delete(old)
    compressedCache.set(key, cached)
    cached.catch(() => compressedCache.delete(key))
  }
  return cached
}
