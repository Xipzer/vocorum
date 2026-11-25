// Windows, driven from WSL: the NSIS installer installs for the current user,
// the app runs with WebView2's debugging port open to localhost only, and a
// small node.exe bridge evaluates in its page. Notifications are read back from
// Windows' toast history. Refuses to run over a Vocorum the person installed.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { AppRun } from './types.ts'

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function ps(command: string): string {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', cwd: '/mnt/c' }).replace(/\r/g, '').trim()
}
const toWsl = (p: string) => execFileSync('wslpath', ['-u', p], { encoding: 'utf8' }).trim()
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

const local = ps('$env:LOCALAPPDATA')
const work = `${local}\\VocorumE2E`
const installed = `${local}\\Vocorum\\vocorum-app.exe`
const node = ps('(Get-Command node).Source')

export function prepareWindows() {
  if (fs.existsSync(toWsl(installed)) && process.env['VOCORUM_E2E_REPLACE_INSTALL'] !== '1') {
    throw new Error(`Vocorum is already installed on Windows (${installed}). Uninstall it first, or set VOCORUM_E2E_REPLACE_INSTALL=1 to let the test replace it.`)
  }
  fs.mkdirSync(toWsl(work), { recursive: true })
  for (const file of ['windows-bridge.mjs']) fs.copyFileSync(path.join(import.meta.dirname, file), path.join(toWsl(work), file))
  fs.copyFileSync(path.resolve(import.meta.dirname, '../../apps/desktop/scripts/measure.mjs'), path.join(toWsl(work), 'measure.mjs'))
}

export function installWindows(installer: string) {
  const target = `${work}\\${path.basename(installer)}`
  fs.copyFileSync(installer, toWsl(target))
  ps(`Stop-Process -Name vocorum-app -ErrorAction SilentlyContinue; Start-Process -Wait ${quote(target)} -ArgumentList '/S'; Start-Sleep 2; Stop-Process -Name vocorum-app -ErrorAction SilentlyContinue; exit 0`)
  if (!fs.existsSync(toWsl(installed))) throw new Error('the installer did not install the app')
  return ps(`(Get-Item ${quote(installed)}).VersionInfo.ProductVersion`)
}

export function uninstallWindows() {
  ps(`Stop-Process -Name vocorum-app -ErrorAction SilentlyContinue; Start-Sleep 1; if (Test-Path ${quote(`${local}\\Vocorum\\uninstall.exe`)}) { Start-Process -Wait ${quote(`${local}\\Vocorum\\uninstall.exe`)} -ArgumentList '/S' }; exit 0`)
  ps(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('dev.xipz.vocorum')`)
  // Device keys of test profiles in Credential Manager.
  ps(`foreach ($c in (cmdkey /list | Select-String 'target=(\\S*dev\\.xipz\\.vocorum\\S*)' | % { $_.Matches[0].Groups[1].Value })) { cmdkey /delete:$c | Out-Null }; exit 0`)
  fs.rmSync(toWsl(work), { recursive: true, force: true })
}

function start(link: string, env: Record<string, string>, dataDir: string, extra: string[] = []) {
  const vars = Object.entries({ VOCORUM_DATA_DIR: dataDir, VOCORUM_NO_APPROVAL_KEY: '1', ...env })
    .map(([k, v]) => `$env:${k}=${quote(v)}`)
    .join('; ')
  const args = [...extra, '--pair', `"${link}"`].map(quote).join(',')
  return Number(ps(`${vars}; (Start-Process ${quote(installed)} -ArgumentList ${args} -PassThru).Id`))
}

export async function launchWindows({ link, env = {} }: { link: string; env?: Record<string, string> }): Promise<AppRun> {
  const port = 9300 + Math.floor(Math.random() * 500)
  const dataDir = `${work}\\profile-${port}`
  const pid = start(link, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, ...env }, dataDir)
  const bridge: ChildProcessWithoutNullStreams = spawn(toWsl(node), [`${work}\\windows-bridge.mjs`, String(port)], { cwd: '/mnt/c' })
  const answers = new Map<number, (m: { value?: unknown; error?: string }) => void>()
  readline.createInterface({ input: bridge.stdout }).on('line', (line) => {
    const m = JSON.parse(line) as { id: number; value?: unknown; error?: string }
    answers.get(m.id)?.(m)
    answers.delete(m.id)
  })
  let id = 0
  return {
    dir: toWsl(work),
    async eval<T>(expression: string): Promise<T> {
      const n = ++id
      const answer = new Promise<{ value?: unknown; error?: string }>((resolve) => answers.set(n, resolve))
      bridge.stdin.write(JSON.stringify({ id: n, expression }) + '\n')
      const m = await answer
      if (m.error) throw new Error(m.error)
      return m.value as T
    },
    async measure(seconds: number) {
      const out = execFileSync(toWsl(node), [`${work}\\measure.mjs`, '--pid', String(pid), '--seconds', String(seconds)], { encoding: 'utf8', cwd: '/mnt/c' })
      const json = JSON.parse(out.slice(out.indexOf('{')))
      return { memoryMB: json.memoryMB as number, cpuPercent: json.cpuPercent as number }
    },
    async notified(text: string) {
      const history = ps(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; foreach ($t in [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('dev.xipz.vocorum')) { $t.Content.GetXml() }`)
      return history.includes(text)
    },
    async stop() {
      bridge.kill()
      ps(`Stop-Process -Id ${pid} -ErrorAction SilentlyContinue; exit 0`)
      await sleep(1500)
    },
  }
}

// Installs `from`, pairs it, and waits until it has updated itself to `version`.
export async function updateWindows({ from, version, link, timeoutMs = 300_000 }: { from: string; version: string; link: string; timeoutMs?: number }) {
  const before = installWindows(from)
  const dataDir = `${work}\\profile-update`
  // Releases before 0.2.4 ignore VOCORUM_DATA_DIR: keep the person's own profile aside meanwhile.
  const profiles = [`${ps('$env:APPDATA')}\\dev.xipz.vocorum`, `${local}\\dev.xipz.vocorum`].map(toWsl)
  const aside = profiles.filter((p) => fs.existsSync(p)).map((p) => (fs.renameSync(p, `${p}.e2e-aside`), p))
  start(link, { VOCORUM_UPDATE_AUTO: '1' }, dataDir, ['--hidden'])
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      await sleep(5000)
      const now = fs.existsSync(toWsl(installed)) ? ps(`(Get-Item ${quote(installed)}).VersionInfo.ProductVersion`) : ''
      if (now === version) {
        await sleep(8000)
        const running = ps(`@(Get-Process vocorum-app -ErrorAction SilentlyContinue | ? { $_.Path -eq ${quote(installed)} }).Count`)
        return { before, after: now, running: Number(running) > 0 }
      }
    }
    return { before, after: ps(`(Get-Item ${quote(installed)}).VersionInfo.ProductVersion`), running: false }
  } finally {
    ps('Stop-Process -Name vocorum-app -ErrorAction SilentlyContinue; exit 0')
    await sleep(1500)
    for (const p of profiles) fs.rmSync(p, { recursive: true, force: true })
    for (const p of aside) fs.renameSync(`${p}.e2e-aside`, p)
  }
}
