// End-to-end test of a Vocorum app build against a throwaway hub: pairing,
// sending, receiving, a native notification, memory budgets, and (with --from)
// updating an older release to this one. Exits 1 when any check fails.
//
//   node --import tsx tests/apps-e2e/run.ts --platform linux|windows --release <dir> [--from <older AppImage|installer>] [--app <file>] [--report <file.json>] [--only main|update]
//
// --release is a folder as `max/scripts/build-apps.sh` or `apps/desktop/scripts/release.sh`
// writes it (release.json and the files). Linux needs tauri-driver and WebKitWebDriver
// (VOCORUM_E2E_WEBDRIVER); Windows runs from WSL with node on Windows.

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { throwawayHub } from './hub.ts'
import type { AppRun } from './types.ts'

const { values: args } = parseArgs({
  options: {
    platform: { type: 'string' },
    release: { type: 'string' },
    app: { type: 'string' },
    from: { type: 'string' },
    report: { type: 'string' },
    only: { type: 'string' },
    'budget-open': { type: 'string' },
    'budget-background': { type: 'string' },
  },
})
const platform = args.platform
if (platform !== 'linux' && platform !== 'windows') throw new Error('--platform linux|windows')
if (!args.release) throw new Error('--release <dir>')
const release = JSON.parse(fs.readFileSync(path.join(args.release, 'release.json'), 'utf8')) as { version: string; files: Record<string, { update?: string; install?: string }> }
const key = platform === 'linux' ? 'linux-x86_64-appimage' : 'windows-x86_64'
const candidate = release.files[key]?.update ?? release.files[key]?.install
if (!candidate) throw new Error(`the release has no ${key} build`)
const app = args.app ?? path.join(args.release, candidate)
// Budgets: the system's own memory figure for the app and its webview, idle.
// Linux under WSL renders in software, so its budget is higher.
const budget = {
  open: Number(args['budget-open'] ?? (platform === 'windows' ? 140 : 450)),
  background: Number(args['budget-background'] ?? 70),
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, fn: () => Promise<T>, timeoutMs = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await fn()
      if (value) return value as NonNullable<T>
    } catch (e) {
      last = e
    }
    if (Date.now() > deadline) throw new Error(`${what}: timed out${last ? ` (${last instanceof Error ? last.message : String(last)})` : ''}`)
    await sleep(500)
  }
}

type Result = { check: string; ok: boolean; ms: number; detail: string }
const results: Result[] = []
async function check(name: string, fn: () => Promise<string | void>) {
  const started = Date.now()
  try {
    const detail = (await fn()) ?? ''
    results.push({ check: name, ok: true, ms: Date.now() - started, detail })
  } catch (e) {
    results.push({ check: name, ok: false, ms: Date.now() - started, detail: e instanceof Error ? e.message : String(e) })
  }
  const r = results.at(-1)!
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${name}${r.detail ? `: ${r.detail}` : ''}`)
  return r.ok
}

const hub = await throwawayHub()
const win = platform === 'windows' ? await import('./windows.ts') : null
const linux = platform === 'linux' ? await import('./linux.ts') : null
const channel = hub.demo.kimaki
const tag = Date.now().toString(36)
let run: AppRun | null = null

// Refuses before anything is touched: the cleanup below uninstalls, so a refusal inside
// the try would remove the person's own app.
if (win) win.prepareWindows()

try {
  if (win) {
    await check('installs', async () => `version ${win.installWindows(app)}`)
  }
  const link = await hub.pairLink(`e2e ${platform}`)
  const paired = args.only !== 'update' && await check('pairs and signs in', async () => {
    run = linux ? await linux.launchLinux({ app, link }) : await win!.launchWindows({ link })
    await until('the channel list', () => run!.eval<boolean>(`Boolean(document.querySelector('.sidebar .channel'))`), 90_000)
  })
  if (paired && run) {
    const page: AppRun = run
    await page.eval(`location.hash = '#/c/${channel.id}'`)
    await check('sends a message', async () => {
      const text = `e2e sent ${tag}`
      await until('the message box', () => page.eval<boolean>(`Boolean(document.querySelector('.chat .composer textarea'))`))
      await page.eval(`(() => {
        const box = document.querySelector('.chat .composer textarea')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)})
        box.dispatchEvent(new Event('input', { bubbles: true }))
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      })()`)
      await until('the hub to get it', async () => (await channel.messages.fetch({ limit: 10 })).some((m) => m.content === text))
    })
    await check('receives a message', async () => {
      const text = `e2e received ${tag}`
      await channel.send(text)
      await until('the message on screen', () => page.eval<boolean>(`document.querySelector('.messages')?.innerText.includes(${JSON.stringify(text)}) ?? false`))
    })
    await check('shows a native notification', async () => {
      // As if the window were in the background: the hub only alerts devices not in use.
      await page.eval(`window.__TAURI_INTERNALS__.invoke('set_focus', { focus: { channel_id: null, visible: false } })`)
      await sleep(1500)
      const text = `e2e alert ${tag}`
      await channel.send(`<@${hub.ownerId}> ${text}`)
      await until('the notification', () => page.notified(text), 20_000)
    })
    await check(`memory with the window open stays under ${budget.open} MB`, async () => {
      await page.eval(`location.hash = '#/c/${channel.id}'`)
      await sleep(15_000)
      const m = await page.measure(30)
      if (m.memoryMB > budget.open) throw new Error(`${m.memoryMB} MB, ${m.cpuPercent}% CPU`)
      return `${m.memoryMB} MB, ${m.cpuPercent}% CPU`
    })
    if (win) {
      await check(`memory minimised stays under ${budget.background} MB`, async () => {
        await page.eval(`window.__TAURI_INTERNALS__.invoke('window_control', { action: 'minimize' })`)
        await sleep(40_000)
        const m = await page.measure(20)
        if (m.memoryMB > budget.background) throw new Error(`${m.memoryMB} MB`)
        return `${m.memoryMB} MB`
      })
    }
    await page.stop()
    run = null
  }
  if (args.from && args.only !== 'main') {
    hub.publish(args.release)
    await check(`updates itself from ${path.basename(args.from)} to ${release.version}`, async () => {
      const link = await hub.pairLink(`e2e ${platform} update`)
      if (linux) {
        const r = await linux.updateLinux({ from: args.from!, to: path.join(args.release!, candidate), link })
        if (!r.replaced) throw new Error('the AppImage was not replaced')
        if (!r.running) throw new Error('replaced, but the app did not start again')
        return 'replaced and restarted'
      }
      const r = await win!.updateWindows({ from: args.from!, version: release.version, link })
      if (r.after !== release.version) throw new Error(`still ${r.after}`)
      if (!r.running) throw new Error('updated, but the app did not start again')
      return `${r.before} to ${r.after}, restarted`
    })
  }
} finally {
  await (run as AppRun | null)?.stop().catch(() => {})
  if (win) win.uninstallWindows()
  await hub.stop()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${platform} ${release.version}: ${results.length - failed.length} of ${results.length} checks passed`)
if (args.report) fs.writeFileSync(args.report, JSON.stringify({ platform, version: release.version, results }, null, 2))
process.exit(failed.length ? 1 : 0)
