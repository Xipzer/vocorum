// What differs between Linux, macOS and Windows on the host side: where the
// tools are, which ports are listening, and the Windows service (a Task
// Scheduler task, since a real Windows service needs an administrator).

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { HUB_NODE_FLAGS, type HubPaths } from './config.ts'

const run = promisify(execFile)
export const WINDOWS = process.platform === 'win32'

// node:sqlite with statement.columns(): Node 22.16 or newer.
export const NODE_MIN = '22.16'
export function nodeSupported(version = process.versions.node) {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 16)
}

// Where these tools live when they are not on PATH: macOS ships Tailscale inside its app,
// and on Windows openssl usually comes with Git.
const KNOWN: Record<string, string[]> = {
  openssl: WINDOWS ? ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe'] : [],
  tailscale: process.platform === 'darwin' ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'] : WINDOWS ? ['C:\\Program Files\\Tailscale\\tailscale.exe'] : [],
}

function onPath(name: string): string | null {
  const exts = WINDOWS ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase())
      if (fs.existsSync(file)) return file
      if (ext && fs.existsSync(path.join(dir, name + ext))) return path.join(dir, name + ext)
    }
  }
  return null
}

const found = new Map<string, string>()
// The command to run for a tool: its name on PATH, or a known install location.
export function tool(name: 'openssl' | 'tailscale'): string {
  if (!found.has(name)) found.set(name, onPath(name) ?? KNOWN[name]?.find((file) => fs.existsSync(file)) ?? name)
  return found.get(name)!
}

async function out(cmd: string, args: string[], timeout = 8000) {
  try {
    return (await run(cmd, args, { timeout, windowsHide: true })).stdout
  } catch {
    return null
  }
}

// Local addresses with a listening TCP socket ("127.0.0.1:47100", "[::1]:47100"), or null when unknown.
export async function listeningSockets(): Promise<string[] | null> {
  if (process.platform === 'linux') {
    const ss = await out('ss', ['-ltnH'])
    return ss === null ? null : ss.split('\n').map((l) => l.trim().split(/\s+/)[3] ?? '').filter(Boolean)
  }
  if (process.platform === 'darwin') {
    const lsof = await out('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'])
    return lsof === null ? null : lsof.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
  }
  if (WINDOWS) {
    const netstat = await out('netstat', ['-ano', '-p', 'TCP'])
    const v6 = await out('netstat', ['-ano', '-p', 'TCPv6'])
    if (netstat === null) return null
    return `${netstat}\n${v6 ?? ''}`.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c[0] === 'TCP' && c[3] === 'LISTENING').map((c) => c[1]!)
  }
  return null
}

// The process listening on a loopback port (Windows: to stop a hub the task started).
export async function pidOnPort(port: number): Promise<number | null> {
  if (!WINDOWS) return null
  const netstat = await out('netstat', ['-ano', '-p', 'TCP'])
  const line = netstat?.split('\n').map((l) => l.trim().split(/\s+/)).find((c) => c[3] === 'LISTENING' && c[1] === `127.0.0.1:${port}`)
  return line ? Number(line[4]) : null
}

// --- Windows: a Task Scheduler task that starts the hub at logon, hidden, and again if it stops.

export const taskName = (service: string) => `\\Vocorum\\${service}`

// wscript runs node with no window and starts it again 5 s after it fails, like systemd's
// Restart=on-failure (Task Scheduler only retries a task that failed to start).
function launcher(paths: HubPaths, repo: string) {
  const quote = (s: string) => `""${s}""`
  const cmd = [process.execPath, ...HUB_NODE_FLAGS, path.join(repo, 'dist', 'hub.mjs'), 'start'].map(quote).join(' ')
  const log = path.join(paths.root, 'hub.log')
  return `' Starts the Vocorum hub with no window. Written by vocorum setup.
Set shell = CreateObject("WScript.Shell")
shell.Environment("Process")("VOCORUM_DIR") = "${paths.root}"
shell.CurrentDirectory = "${repo}"
Do
  code = shell.Run("cmd /c ""${cmd} >> ${quote(log)} 2>&1""", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 5000
Loop
`
}

const ps = (script: string) => out('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 30_000)

export async function installTask(paths: HubPaths, repo: string, service: string): Promise<{ changed: boolean; file: string }> {
  const file = path.join(paths.root, 'hub-service.vbs')
  const body = launcher(paths, repo)
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body && (await taskState(service)) !== null
  if (same) return { changed: false, file }
  fs.writeFileSync(file, body)
  await registerTask(service, file, `Vocorum hub (${paths.root})`)
  return { changed: true, file }
}

// A task that runs a .vbs launcher at logon for this user, with no administrator.
async function registerTask(service: string, launcherFile: string, description: string) {
  const name = taskName(service)
  const folder = name.slice(0, name.lastIndexOf('\\') + 1)
  const leaf = name.slice(name.lastIndexOf('\\') + 1)
  const result = await ps(
    [
      `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${launcherFile}"'`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
      // Never stopped for running long or on battery; retried if it fails to start.
      `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew`,
      `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
      `Register-ScheduledTask -TaskPath '${folder}' -TaskName '${leaf}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '${description.replace(/'/g, "''")}' -Force | Out-Null`,
      `'ok'`,
    ].join('; '),
  )
  if (!result?.includes('ok')) throw new Error(`Could not register the scheduled task ${name}. Run in PowerShell: Get-ScheduledTask -TaskPath '${folder}'`)
}

// "Running", "Ready", "Disabled", or null when there is no such task.
export async function taskState(service: string): Promise<string | null> {
  const name = taskName(service)
  const stdout = await ps(`(Get-ScheduledTask -TaskPath '${name.slice(0, name.lastIndexOf('\\') + 1)}' -TaskName '${name.slice(name.lastIndexOf('\\') + 1)}' -ErrorAction SilentlyContinue).State`)
  return stdout?.trim() || null
}

// Starts the task's hub; a running one is stopped first (the task's own process and the hub's).
export async function restartTask(service: string, port: number) {
  const name = taskName(service)
  await out('schtasks', ['/End', '/TN', name])
  const pid = await pidOnPort(port)
  if (pid) await out('taskkill', ['/PID', String(pid), '/T', '/F'])
  for (let i = 0; i < 20 && (await pidOnPort(port)); i++) await new Promise((r) => setTimeout(r, 250))
  if ((await out('schtasks', ['/Run', '/TN', name])) === null) throw new Error(`schtasks could not start ${name}. Is it installed? vocorum setup`)
}

export async function removeTask(service: string) {
  await out('schtasks', ['/Delete', '/TN', taskName(service), '/F'])
}

// --- macOS

export const launchdLabel = (service: string) => `dev.${service}`
export const launchdFile = (service: string) => path.join(os.homedir(), `Library/LaunchAgents/${launchdLabel(service)}.plist`)

// "running", "not running", or null when launchd does not know the agent.
export async function launchdState(service: string): Promise<string | null> {
  const stdout = await out('launchctl', ['print', `gui/${process.getuid?.()}/${launchdLabel(service)}`])
  if (stdout === null) return null
  return /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim() ?? 'unknown'
}

// --- an agent (Kimaki) as a service on macOS or Windows: its secrets stay in its env file,
// read when it starts, never copied into the service definition.

export type AgentService = { name: string; description: string; command: string[]; envFile: string; env: Record<string, string>; cwd: string; log: string }

export async function installAgentService(service: AgentService, root: string): Promise<string> {
  if (process.platform === 'darwin') {
    const file = launchdFile(service.name)
    const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const args = ['/bin/sh', '-c', `set -a; . "${service.envFile}"; set +a; exec "$0" "$@"`, ...service.command]
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${launchdLabel(service.name)}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(service.env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>WorkingDirectory</key><string>${xml(service.cwd)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(service.log)}</string><key>StandardErrorPath</key><string>${xml(service.log)}</string>
</dict></plist>
`
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body, { mode: 0o600 })
      await out('launchctl', ['bootout', `gui/${process.getuid?.()}`, file])
      await out('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, file])
    } else await out('launchctl', ['kickstart', `gui/${process.getuid?.()}/${launchdLabel(service.name)}`])
    return `launchd agent ${launchdLabel(service.name)}`
  }
  if (WINDOWS) {
    const file = path.join(root, `${service.name}.vbs`)
    const vbs = (s: string) => s.replace(/"/g, '""')
    const quote = (s: string) => `""${vbs(s)}""`
    const cmd = service.command.map(quote).join(' ')
    const body = `' Starts ${vbs(service.description)} with no window. Written by vocorum.
Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("Process")
Set files = CreateObject("Scripting.FileSystemObject")
Set f = files.OpenTextFile("${vbs(service.envFile)}", 1)
Do Until f.AtEndOfStream
  line = f.ReadLine
  i = InStr(line, "=")
  If i > 1 And Left(line, 1) <> "#" Then env(Left(line, i - 1)) = Mid(line, i + 1)
Loop
f.Close
${Object.entries(service.env).map(([k, v]) => `env("${vbs(k)}") = "${vbs(v)}"`).join('\n')}
shell.CurrentDirectory = "${vbs(service.cwd)}"
Do
  code = shell.Run("cmd /c ""${cmd} >> ${quote(service.log)} 2>&1""", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 10000
Loop
`
    fs.writeFileSync(file, body)
    await registerTask(service.name, file, service.description)
    await out('schtasks', ['/End', '/TN', taskName(service.name)])
    await out('schtasks', ['/Run', '/TN', taskName(service.name)])
    return `Task Scheduler task ${taskName(service.name)}`
  }
  throw new Error('No service manager here')
}

// "running" or another state, null when not installed.
export async function agentServiceState(name: string): Promise<string | null> {
  if (process.platform === 'darwin') return launchdState(name)
  if (WINDOWS) return (await taskState(name))?.toLowerCase() ?? null
  return null
}
