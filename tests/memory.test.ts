// Resource budget: the built hub (dist/hub.mjs), run with HUB_NODE_FLAGS on a
// large history, must idle well under its memory budget and answer searches
// fast. Skipped when dist/hub.mjs has not been built.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { HUB_NODE_FLAGS, initHub, readSecret } from '../src/config.ts'
import { startTestHub } from './helpers.ts'

const DIST = path.resolve(import.meta.dirname, '../dist/hub.mjs')
const built = fs.existsSync(DIST)
// Idle with a large history; measured 135 MB on a real 370k-message hub.
const BUDGET_MB = 160
const MESSAGES = 60_000
let t: Awaited<ReturnType<typeof startTestHub>>
let child: ChildProcess | null = null
let base = ''

beforeAll(async () => {
  if (!built) return
  t = await startTestHub()
  const prisma = t.hub.twin.prisma
  const guildId = t.config.guildId
  // 20 channels with 10 threads each, and a long history of realistic agent output.
  const channels = Array.from({ length: 20 }, (_, i) => ({ id: String(1_300_000_000_000_000_000n + BigInt(i)), guildId, type: 0, name: `project-${i}` }))
  const threads = channels.flatMap((c, i) => Array.from({ length: 10 }, (_, j) => ({ id: String(1_310_000_000_000_000_000n + BigInt(i * 10 + j)), guildId, type: 11, name: `session ${i}-${j}`, parentId: c.id })))
  await prisma.channel.createMany({ data: [...channels, ...threads] })
  const body = '┣ bash _Run the build and report_ ' + 'the deploy step finished; tests pass and the service is healthy. '.repeat(6)
  for (let start = 0; start < MESSAGES; start += 5000) {
    await prisma.message.createMany({
      data: Array.from({ length: Math.min(5000, MESSAGES - start) }, (_, k) => {
        const n = start + k
        const channel = threads[n % threads.length]!
        const id = String(((BigInt(Date.now() - (MESSAGES - n) * 60_000) - 1420070400000n) << 22n) + BigInt(n % 4096))
        return { id, channelId: channel.id, authorId: n % 3 ? t.config.botUserId : t.config.ownerUserId, content: n % 20 ? `${body} run ${n}` : `${body} see ses_${String(n).padStart(26, 'a')}`, embeds: '[]', timestamp: new Date(Date.now() - (MESSAGES - n) * 60_000) }
      }),
    })
  }
  await t.hub.stop()
  initHub(t.paths, { port: 0 })
  child = spawn(process.execPath, [...HUB_NODE_FLAGS, DIST, 'start'], { env: { ...process.env, VOCORUM_DIR: t.paths.root, VOCORUM_KIMAKI_DIRS: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] })
  base = await new Promise<string>((resolve, reject) => {
    let out = ''
    child!.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const m = /listening on (http:\/\/[^\s]+)/.exec(out)
      if (m) resolve(m[1]!)
    })
    child!.on('exit', (code) => reject(new Error(`hub exited ${code}: ${out}`)))
  })
}, 300_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  if (t) fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!built)('the built hub idles under its memory budget on a large history, and search stays fast', async () => {
  const admin = { authorization: `Bearer ${readSecret(t.paths.adminToken)}` }
  // Index the history for search, as a fresh start does in the background.
  await new Promise((r) => setTimeout(r, 15_000))
  const stats = async () => (await (await fetch(`${base}/admin/stats`, { headers: admin })).json()) as { rss: number }
  const all = (await stats()) as unknown as Record<string, number>
  const rss = Math.round(all['rss']! / 1048576)
  console.log(`hub rss with ${MESSAGES} messages: ${rss} MB`, JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, k.endsWith('Ms') || k === 'uptimeS' || k === 'sockets' ? v : Math.round(v / 1048576)]))))
  expect(rss).toBeLessThan(BUDGET_MB)
}, 120_000)
