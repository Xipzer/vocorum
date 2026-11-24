// The app's files: text assets compressed when the browser accepts it,
// everything else as stored, and nothing outside the web directory.

import fs from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { serveStatic } from '../src/static.ts'

let dir = ''
let server: http.Server
let base = ''
const script = `console.log(${JSON.stringify('x'.repeat(20_000))})`

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), script)
  fs.writeFileSync(path.join(dir, 'assets', 'icon.png'), Buffer.alloc(5000, 1))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>')
  server = http.createServer((req, res) => void serveStatic(req, res, new URL(req.url ?? '/', 'http://x').pathname, dir))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function get(pathname: string, encoding: string) {
  return new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.get(`${base}${pathname}`, { headers: { 'accept-encoding': encoding } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('text assets go out compressed, Brotli first, and decode to the file', async () => {
  const br = await get('/assets/app.js', 'gzip, deflate, br')
  expect(br.headers['content-encoding']).toBe('br')
  expect(br.headers['vary']).toBe('Accept-Encoding')
  expect(zlib.brotliDecompressSync(br.body).toString()).toBe(script)
  expect(br.body.length).toBeLessThan(script.length / 10)
  const gz = await get('/assets/app.js', 'gzip')
  expect(zlib.gunzipSync(gz.body).toString()).toBe(script)
  const plain = await get('/assets/app.js', 'identity')
  expect(plain.headers['content-encoding']).toBeUndefined()
  expect(plain.body.toString()).toBe(script)
})

test('images are sent as stored, and paths cannot leave the web directory', async () => {
  const png = await get('/assets/icon.png', 'br')
  expect(png.headers['content-encoding']).toBeUndefined()
  expect(png.body.length).toBe(5000)
  expect((await get('/../../etc/passwd', 'br')).body.toString()).toContain('<title>app</title>')
})
