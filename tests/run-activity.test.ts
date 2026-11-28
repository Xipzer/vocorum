// The working clock comes from the agent's own run journal, read on a disposable hub.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { Hub } from '../src/hub.ts'
import { type ActivitySnapshot } from '../src/run-activity.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>, phone: TestDevice, dir: string, A: string, B: string
const R = 'session_fixture_a',
  S = 'session_fixture_b',
  t0 = Date.now() - 240_000
const sockets = new Set<WebSocket>()
type Packet = { t: string; d: ActivitySnapshot & { watch?: number; id?: string } }
const record = (thread: string, ...events: unknown[]) =>
  fs.appendFileSync(
    path.join(dir, 'session-events', thread + '.jsonl'),
    events.map((e) => JSON.stringify({ at: t0 + 200_000, event: e }) + '\n').join(''),
  )
const ev = (root: string, seq: number, type: string, data: Record<string, unknown> = {}) => ({
  id: `evt_${root}_${seq}`,
  type,
  created: t0 + seq * 1000,
  durable: { aggregateID: root, seq, version: 1 },
  data: { sessionID: root, ...data },
})
const snapshot = (root: string, offset: number, active: boolean) => ({
  type: 'kimaki.snapshot',
  at: t0 + offset,
  activeSessionIds: active ? [root] : [],
  sessions: [{ sessionId: root, inbox: [], forms: [], permissions: [] }],
})
const view = (id: string) => t.hub.sessions.activity.read(id)
const overview = async (id: string) => (await phone.json('/client/overview')).sessions.find((s: { id: string }) => s.id === id)
function bind(thread: string, root: string, home = dir) {
  const db = new DatabaseSync(path.join(home, 'kimaki.db'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS thread_sessions (thread_id TEXT PRIMARY KEY, session_id TEXT)')
    db.prepare('INSERT OR REPLACE INTO thread_sessions VALUES (?,?)').run(thread, root)
  } finally {
    db.close()
  }
}
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-fixture-'))
  fs.mkdirSync(path.join(dir, 'session-events'))
  vi.stubEnv('VOCORUM_KIMAKI_DIRS', dir)
  vi.stubEnv('VOCORUM_SYSTEMCTL', '/bin/false')
  t = await startTestHub({ extensions: [] })
  phone = await pairedDevice(t.hub)
  const parent = (await phone.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  const add = async (name: string) => (await t.hub.twin.simulateChannelCreate({ guildId: t.config.guildId, parentId: parent, type: 11, name })).id
  A = await add('Orchard')
  B = await add('Footpaths')
  bind(A, R)
  bind(B, S)
})
async function close(ws: WebSocket) {
  const done = once(ws, 'close')
  ws.close()
  await done
  sockets.delete(ws)
}
afterEach(async () => {
  try {
    await Promise.all([...sockets].map(close))
    await waitFor(() => t.hub.events.connections().length === 0)
    await t.cleanup()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})
async function listen(device = phone, login = LOGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, {
    headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login },
  })
  const packets: Packet[] = []
  sockets.add(ws)
  ws.on('message', (raw) => packets.push(JSON.parse(String(raw))))
  await waitFor(() => packets.some((p) => p.t === 'HELLO'))
  return {
    ws,
    packets,
  }
}

test('only a bound root start supplies elapsed time; an active snapshot, typing, tool or queue receipt cannot start it', async () => {
  await phone.json(`/client/channels/${A}/messages`, { method: 'POST', json: { content: 'An invented request.' } })
  const bot = await t.hub.store.addBot('fixture')
  await t.hub.reload()
  expect(
    (
      await fetch(`${t.hub.localUrl}/api/v10/channels/${A}/typing`, {
        method: 'POST',
        headers: { authorization: `Bot ${bot.clientId}:${bot.secret}` },
      })
    ).status,
  ).toBe(204)
  record(
    A,
    snapshot(R, 100, true),
    ev('child_fixture', 1, 'session.execution.started'),
    ev(R, 2, 'session.inbox.enqueued', {
      inboxID: 'request_one',
      item: { type: 'user', delivery: 'queue', payload: { text: 'private-fixture-input' } },
    }),
    ev(R, 3, 'session.tool.input.started', { assistantMessageID: 'answer', id: 'action', name: 'read' }),
    ev(R, 4, 'session.tool.called', { assistantMessageID: 'answer', id: 'action', input: { text: 'private-fixture-input' } }),
  )
  expect((await view(A)).run).toMatchObject({ state: 'running', started_at: null, id: null })
  expect((await overview(A)).runStartedAt).toBeNull()
  record(
    A,
    ev(R, 5, 'session.execution.started'),
    ev(R, 6, 'session.reasoning.ended', { text: 'private-fixture-input' }),
    ev(R, 7, 'session.inbox.delivered', { inboxID: 'request_one' }),
  )
  const s = await view(A)
  expect(s.run).toMatchObject({ id: `evt_${R}_5`, started_at: t0 + 5000 })
  expect(s.pending).toEqual([])
  expect(JSON.stringify(s)).not.toContain('private-fixture-input')
  expect(s.events.find((e) => e.kind === 'session.tool.called')?.tool).toBe('read')
  expect((await overview(A)).runStartedAt).toBe(t0 + 5000)
  // Same start replayed late, followed by a real interrupt with a correction queued.
  record(
    A,
    ev(R, 8, 'session.inbox.enqueued', { inboxID: 'correction', item: { type: 'user', delivery: 'queue' } }),
    ev(R, 9, 'session.execution.interrupted', { reason: 'user' }),
    ev(R, 5, 'session.execution.started'),
  )
  const after = await view(A)
  expect(after.run).toMatchObject({ state: 'ended', started_at: t0 + 5000, ended_at: t0 + 9000, reason: 'user' })
  expect(after.pending.map((r) => r.id)).toEqual(['correction'])
  expect((await overview(A)).runStartedAt).toBeNull()
  record(A, ev(R, 10, 'session.execution.started'), ev(R, 11, 'session.inbox.delivered', { inboxID: 'correction' }))
  expect((await view(A)).pending).toEqual([])
  expect((await view(A)).run.started_at).toBe(t0 + 10000)
})

test('hub restart recovers the original clock; unknown, rotated and rebound journals cannot borrow another start', async () => {
  record(A, ev(R, 1, 'session.execution.started'))
  expect((await view(A)).run.started_at).toBe(t0 + 1000)
  const cookie = phone.cookie
  await t.hub.stop()
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, extensions: [] })
  await t.hub.start()
  phone = new TestDevice(t.hub)
  phone.cookie = cookie
  const c = await listen()
  c.ws.send(JSON.stringify({ op: 'focus', d: { channel_id: A } }))
  await waitFor(() => c.packets.some((p) => p.t === 'SESSION_STATE' && p.d.id === A && (p.d as any).runStartedAt === t0 + 1000))
  expect(c.packets.some((p) => p.t === 'WORKSPACE_ACTIVITY')).toBe(false)
  expect((await view(A)).run.started_at).toBe(t0 + 1000)
  expect((await view(B)).available).toBe(false)
  const file = path.join(dir, 'session-events', A + '.jsonl')
  fs.writeFileSync(file, '')
  record(A, snapshot(R, 40000, true))
  expect((await view(A)).run.started_at).toBeNull()
  record(A, ev(R, 50, 'session.execution.started'))
  expect((await view(A)).run.started_at).toBe(t0 + 50000)
  record(A, snapshot(R, 51000, true))
  expect((await view(A)).run.started_at).toBeNull()
  record(A, ev(R, 55, 'session.execution.started'))
  const other = path.join(dir, 'peer')
  fs.mkdirSync(other)
  bind(A, S, other)
  vi.stubEnv('VOCORUM_KIMAKI_DIRS', [dir, other].join(':'))
  expect((await view(A)).available).toBe(false)
  vi.stubEnv('VOCORUM_KIMAKI_DIRS', dir)
  expect((await view(A)).run.started_at).toBe(t0 + 55000)
  bind(A, 'another_root')
  expect((await view(A)).run.started_at).toBeNull()
})

test('no client can read a thread journal: there is no route and no subscription', async () => {
  record(A, ev(R, 1, 'session.execution.started'))
  expect((await phone.fetch(`/client/channels/${A}/activity`)).status).toBe(404)
  const c = await listen()
  c.ws.send(JSON.stringify({ op: 'activity', d: { channel_id: A, watch: 1 } }))
  c.ws.send(JSON.stringify({ op: 'focus', d: { channel_id: A } }))
  await waitFor(() => c.packets.some((p) => p.t === 'SESSION_STATE' && p.d.id === A))
  expect(c.packets.some((p) => p.t === 'WORKSPACE_ACTIVITY')).toBe(false)
})
