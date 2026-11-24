// A small Discord REST client for the importer and the purge. It waits out
// rate limits the way Discord asks (retry_after on 429, the bucket headers
// otherwise), retries server errors and network failures, and returns
// Discord's error code with every failure so a report can group them.
// The token stays in this object; nothing here prints or stores it.

export const DISCORD_API = process.env['VOCORUM_DISCORD_API'] || 'https://discord.com/api/v10'

export type DiscordResult<T> = { status: number; data: T | null; code: number | null; message: string | null }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class DiscordRest {
  // Requests in flight wait here when Discord says the whole bot is limited.
  private globalUntil = 0
  requests = 0

  constructor(
    private readonly token: string,
    private readonly base = DISCORD_API,
  ) {}

  async call<T = unknown>(method: string, path: string, body?: unknown, reason?: string): Promise<DiscordResult<T>> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const wait = this.globalUntil - Date.now()
      if (wait > 0) await sleep(wait)
      const headers: Record<string, string> = { authorization: `Bot ${this.token}`, 'user-agent': 'DiscordBot (https://github.com/vocorum, 1)' }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (reason) headers['x-audit-log-reason'] = encodeURIComponent(reason)
      let response: Response
      try {
        this.requests++
        response = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
      } catch {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      const text = await response.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {}
      if (response.status === 429) {
        const retry = Number((data as { retry_after?: number } | null)?.retry_after ?? response.headers.get('retry-after') ?? 1)
        if ((data as { global?: boolean } | null)?.global) this.globalUntil = Date.now() + retry * 1000
        await sleep(retry * 1000 + 200)
        attempt--
        continue
      }
      if (response.status >= 500) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      if (response.headers.get('x-ratelimit-remaining') === '0') await sleep(Number(response.headers.get('x-ratelimit-reset-after') ?? 1) * 1000)
      if (!response.ok) {
        const error = data as { code?: number; message?: string } | null
        return { status: response.status, data: null, code: error?.code ?? null, message: error?.message ?? null }
      }
      return { status: response.status, data: data as T, code: null, message: null }
    }
    return { status: 0, data: null, code: null, message: 'Discord kept failing' }
  }

  // GET that throws on anything but success, for steps that cannot go on without it.
  async get<T>(path: string): Promise<T> {
    const result = await this.call<T>('GET', path)
    if (result.status === 401) throw new Error('Discord refused the bot token (401). Check the token file, or make a new token in the Discord developer portal (your app, Bot, Reset Token).')
    if (result.data === null) throw new Error(`Discord GET ${path.split('?')[0]} answered ${result.status}${result.code ? ` (code ${result.code})` : ''}${result.message ? `: ${result.message}` : ''}`)
    return result.data
  }

  // GET that returns null when the bot may not see it (403) or it is gone (404).
  async maybe<T>(path: string): Promise<T | null> {
    const result = await this.call<T>('GET', path)
    if (result.data !== null) return result.data
    if (result.status === 401) throw new Error('Discord refused the bot token (401). Check the token file, or make a new token in the Discord developer portal (your app, Bot, Reset Token).')
    if ([403, 404, 405].includes(result.status)) return null
    throw new Error(`Discord GET ${path.split('?')[0]} answered ${result.status}${result.code ? ` (code ${result.code})` : ''}`)
  }
}

// Discord snowflake to milliseconds since the epoch.
export const snowflakeTime = (id: string) => Number(BigInt(id) >> 22n) + 1420070400000

export const THREAD_TYPES = new Set([10, 11, 12])
// Text, announcement, forum and media channels hold messages or threads.
export const TEXT_TYPES = new Set([0, 5, 15, 16])
