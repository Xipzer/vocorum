#!/usr/bin/env node
// Memory and CPU of an app and every process it uses (its child processes,
// and on macOS the WebKit processes that appeared after it started), sampled
// over a window. Works on Linux, macOS and Windows with no dependencies.
//
//   node measure.mjs --pid 1234 [--seconds 60] [--webkit-before 1,2,3] [--label vocorum-idle]
//
// Memory: Linux PSS (shared pages split fairly), macOS physical footprint
// (Activity Monitor's Memory), Windows private working set (Task Manager's
// Memory). CPU: CPU time used during the window, as a percentage of one core.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => (arg.startsWith('--') ? [...acc, [arg.slice(2), all[i + 1]?.startsWith('--') ? 'true' : (all[i + 1] ?? 'true')]] : acc), []),
)
const rootPid = Number(args.pid)
const seconds = Number(args.seconds ?? 60)
const webkitBefore = new Set(String(args['webkit-before'] ?? '').split(',').filter(Boolean).map(Number))
if (!rootPid) {
  console.error('usage: measure.mjs --pid <app pid> [--seconds 60] [--webkit-before pids] [--label name]')
  process.exit(2)
}

const run = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

function linux() {
  const tick = 100
  const all = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)
  const parent = new Map()
  for (const pid of all) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      parent.set(pid, Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
    } catch {}
  }
  const tree = new Set([rootPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, ppid] of parent) if (tree.has(ppid) && !tree.has(pid)) tree.add(pid), (grew = true)
  }
  const procs = []
  for (const pid of tree) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const cpu = (Number(fields[11]) + Number(fields[12])) / tick
      const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
      const pss = Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0) * 1024
      const name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
      procs.push({ pid, name, memory: pss, cpu })
    } catch {}
  }
  return procs
}

function mac() {
  const rows = run('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm=']).trim().split('\n').map((line) => {
    const [pid, ppid, rss, time, ...comm] = line.trim().split(/\s+/)
    const [min, sec] = time.split(':')
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, cpu: Number(min) * 60 + Number(sec), name: comm.join(' ').split('/').pop() }
  })
  const tree = new Set([rootPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) tree.add(r.pid), (grew = true)
  }
  // WebKit's helpers belong to launchd: count the ones that appeared with the app.
  if (args['webkit-before'] !== undefined) for (const r of rows) if (/^com\.apple\.WebKit\./.test(r.name) && !webkitBefore.has(r.pid)) tree.add(r.pid)
  const procs = rows.filter((r) => tree.has(r.pid))
  for (const p of procs) {
    try {
      const out = run('footprint', ['-p', String(p.pid)])
      const m = /phys_footprint:\s+([\d.]+)\s*([KMG]B)/.exec(out) ?? /Footprint:\s+([\d.]+)\s*([KMG]B)/.exec(out)
      p.memory = m ? Number(m[1]) * { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]] : p.rss
    } catch {
      p.memory = p.rss
    }
  }
  return procs
}

function windows() {
  const script = `
$all = Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime
$tree = New-Object System.Collections.Generic.HashSet[int]; [void]$tree.Add(${rootPid})
do { $grew = $false; foreach ($p in $all) { if ($tree.Contains([int]$p.ParentProcessId) -and -not $tree.Contains([int]$p.ProcessId)) { [void]$tree.Add([int]$p.ProcessId); $grew = $true } } } while ($grew)
$ws = @{}; foreach ($s in (Get-CimInstance Win32_PerfRawData_PerfProc_Process)) { $ws[[int]$s.IDProcess] = $s.WorkingSetPrivate }
$all | Where-Object { $tree.Contains([int]$_.ProcessId) } | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($ws[[int]$_.ProcessId])\`t$(([double]$_.KernelModeTime + [double]$_.UserModeTime) / 1e7)" }`
  return run('powershell.exe', ['-NoProfile', '-Command', script])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, name, memory, cpu] = line.split('\t')
      return { pid: Number(pid), name, memory: Number(memory || 0), cpu: Number(cpu) }
    })
}

const sample = { linux, darwin: mac, win32: windows }[os.platform()]
const first = sample()
const started = Date.now()
const peaks = []
while (Date.now() - started < seconds * 1000) {
  await new Promise((r) => setTimeout(r, Math.min(5000, seconds * 1000)))
  peaks.push(sample().reduce((sum, p) => sum + p.memory, 0))
}
const last = sample()
const elapsed = (Date.now() - started) / 1000
const before = new Map(first.map((p) => [p.pid, p.cpu]))
const cpu = last.reduce((sum, p) => sum + (p.cpu - (before.get(p.pid) ?? p.cpu)), 0)
const mb = (n) => Math.round((n / 1024 ** 2) * 10) / 10
const result = {
  label: args.label ?? null,
  platform: os.platform(),
  processes: last.length,
  memoryMB: mb(last.reduce((sum, p) => sum + p.memory, 0)),
  peakMemoryMB: mb(Math.max(...peaks, 0)),
  cpuPercent: Math.round((cpu / elapsed) * 1000) / 10,
  seconds: Math.round(elapsed),
  byProcess: last.map((p) => ({ name: p.name, memoryMB: mb(p.memory) })),
}
console.log(JSON.stringify(result, null, 2))
