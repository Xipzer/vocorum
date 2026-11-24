import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hubPaths, initHub } from '../src/config.ts'
import { Hub, type HubOptions } from '../src/hub.ts'
import { SoftAuthenticator } from './authenticator.ts'

export const LOGIN = 'owner@example.com'

export async function startTestHub({ tailscaleLogin = LOGIN, push }: { tailscaleLogin?: string | null; push?: HubOptions['push'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-test-'))
  const paths = hubPaths(root)
  const config = initHub(paths, { tailscaleLogin })
  const webDir = path.join(root, 'web')
  fs.mkdirSync(webDir)
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>hub</title>')
  const hub = new Hub({ paths, config, port: 0, webDir, push })
  await hub.start()
  return {
    hub,
    paths,
    config,
    origin: () => `http://localhost:${hub.port}`,
    async cleanup() {
      // this.hub: a test may have restarted it.
      await this.hub.stop()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// A browser on a paired device: Tailscale header, same-origin, session cookie.
export class TestDevice {
  cookie: string | null = null
  readonly authenticator = new SoftAuthenticator()

  constructor(
    private readonly hub: Hub,
    private readonly headers: Record<string, string> = { 'tailscale-user-login': LOGIN },
  ) {}

  get origin() {
    return `http://localhost:${this.hub.port}`
  }

  async fetch(pathname: string, init: RequestInit & { json?: unknown } = {}) {
    const headers: Record<string, string> = { ...this.headers, origin: this.origin, ...(init.headers as Record<string, string>) }
    if (this.cookie) headers['cookie'] = this.cookie
    let body = init.body
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const response = await fetch(`${this.hub.localUrl}${pathname}`, { ...init, headers, body })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';')[0]!
    return response
  }

  async json<T = any>(pathname: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const response = await this.fetch(pathname, init)
    const text = await response.text()
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${response.status} ${text}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  async pair(code: string) {
    const { challengeId, options } = await this.json('/client/auth/register/options', { method: 'POST', json: { code } })
    return this.json('/client/auth/register/verify', { method: 'POST', json: { challengeId, response: this.authenticator.register(options, this.origin) } })
  }

  async login() {
    const { challengeId, options } = await this.json('/client/auth/login/options', { method: 'POST', json: {} })
    return this.json('/client/auth/login/verify', { method: 'POST', json: { challengeId, response: this.authenticator.authenticate(options, this.origin) } })
  }
}

export async function pairedDevice(hub: Hub, name = 'phone') {
  const device = new TestDevice(hub)
  const code = await hub.store.createPairing(name)
  await device.pair(code)
  return device
}

export async function waitFor<T>(fn: () => T | Promise<T>, { timeout = 10_000 } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
