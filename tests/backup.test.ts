// Recovery and leaving: a backup restores into an empty folder with the same CA,
// devices, bots, messages, files and Kimaki sessions; restore never overwrites a
// hub by accident; export writes plain files with only the owner's own direct
// messages; uninstall lists before it acts and keeps data unless told.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { backup, restore } from '../src/backup.ts'
import { hubPaths, initHub } from '../src/config.ts'
import { exportHub, uninstall } from '../src/leave.ts'
import { pairedDevice, startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-backup-'))
let fileHash = ''

beforeAll(async () => {
  t = await startTestHub()
  await pairedDevice(t.hub, 'phone')
  await t.hub.store.addBot('desk')
  const general = (await t.hub.twin.prisma.channel.findFirst({ where: { guildId: t.config.guildId, type: 0 } }))!
  const data = crypto.randomBytes(20_000)
  fileHash = crypto.createHash('sha256').update(data).digest('hex')
  const saved = await t.hub.attachments.save({ id: '1575100000000000001', filename: 'notes.txt', contentType: 'text/plain', data, uploadedBy: 'test', durationSecs: null, waveform: null })
  await t.hub.twin.prisma.message.create({ data: { id: '1575100000000000002', channelId: general.id, authorId: t.config.ownerUserId, content: 'with a file', attachments: JSON.stringify([{ id: saved.id, filename: 'notes.txt', url: saved.url }]) } })
  for (let i = 0; i < 20; i++) await t.hub.twin.prisma.message.create({ data: { id: String(1575100000000000100n + BigInt(i)), channelId: general.id, authorId: t.config.ownerUserId, content: `line ${i} for <@${t.config.ownerUserId}>` } })
  // Two direct messages: the owner with sam, and sam with robin.
  for (const [id, username] of [['1575100000000000201', 'sam'], ['1575100000000000202', 'robin']]) await t.hub.twin.prisma.user.create({ data: { id: id!, username: username! } })
  const dm = async (channel: string, a: string, b: string, text: string) => {
    await t.hub.twin.prisma.channel.create({ data: { id: channel, type: 1 } })
    await t.hub.store.db.execute({ sql: 'INSERT INTO dm_channels (channel_id, user_a, user_b, machine, created_at) VALUES (?, ?, ?, NULL, ?)', args: [channel, a, b, Date.now()] })
    await t.hub.twin.prisma.message.create({ data: { id: String(BigInt(channel) + 1n), channelId: channel, authorId: a, content: text } })
  }
  await dm('1575100000000000301', t.config.ownerUserId, '1575100000000000201', 'hello from the owner')
  await dm('1575100000000000401', '1575100000000000201', '1575100000000000202', 'just between sam and robin')
  fs.mkdirSync(path.join(t.paths.root, 'kimaki-data'))
  const kimaki = createClient({ url: `file:${path.join(t.paths.root, 'kimaki-data', 'kimaki.db')}` })
  await kimaki.execute('CREATE TABLE thread_sessions (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL)')
  await kimaki.execute("INSERT INTO thread_sessions VALUES ('1575100000000000501', 'ses_backuptest0000000000001')")
  kimaki.close()
})

afterAll(async () => {
  await t?.cleanup()
  fs.rmSync(work, { recursive: true, force: true })
})

test('a backup restores into an empty folder with everything, and checks itself against its manifest', async () => {
  const made = await backup(t.paths, path.join(work, 'b1'))
  expect(made.manifest.counts).toMatchObject({ messages: 23, attachments: 1, devices: 1, bots: 1, kimaki_sessions: 1 })
  expect(fs.existsSync(path.join(work, 'b1', 'kimaki-data', 'kimaki.db'))).toBe(true)
  if (process.platform !== 'win32') expect(fs.statSync(path.join(work, 'b1', 'admin-token')).mode & 0o777).toBe(0o600)
  const target = hubPaths(path.join(work, 'restored'))
  const restored = await restore(target, path.join(work, 'b1'))
  expect(restored.problems).toEqual([])
  expect(restored.counts).toEqual(made.manifest.counts)
  expect(restored.ca_fingerprint).toBe(made.manifest.ca_fingerprint)
  for (const secret of ['admin-token', 'signing-key', 'config.json']) expect(fs.readFileSync(path.join(target.root, secret))).toEqual(fs.readFileSync(path.join(t.paths.root, secret)))
  const file = fs.readFileSync(path.join(target.root, 'attachments', '1575100000000000001', 'notes.txt'))
  expect(crypto.createHash('sha256').update(file).digest('hex')).toBe(fileHash)
  expect(fs.existsSync(path.join(target.root, 'manifest.json'))).toBe(false)
})

test('restore refuses a running hub and a folder in use, and --replace moves the old one aside', async () => {
  await expect(restore(t.paths, path.join(work, 'b1'))).rejects.toThrow(/is running/)
  const busy = hubPaths(path.join(work, 'busy'))
  initHub(busy, { port: 1 })
  await expect(restore(busy, path.join(work, 'b1'))).rejects.toThrow(/not empty/)
  const replaced = await restore(busy, path.join(work, 'b1'), { replace: true })
  expect(replaced.moved_aside).toMatch(/busy\.before-restore-/)
  expect(fs.existsSync(path.join(replaced.moved_aside!, 'config.json'))).toBe(true)
  await expect(restore(busy, work)).rejects.toThrow(/not a Vocorum backup/)
})

test('export: plain files with every channel, the owner\'s own direct messages only, and the files', async () => {
  const out = path.join(work, 'export')
  const result = await exportHub(t.config, t.paths, out)
  expect(result).toMatchObject({ messages: 22, files: 1, direct_messages: 1 })
  const all = fs.readdirSync(out, { recursive: true }).map(String)
  const text = all.filter((f) => f.endsWith('.md') || f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n')
  expect(text).toContain('hello from the owner')
  expect(text).not.toContain('just between sam and robin')
  expect(text).toContain(`line 3 for @${t.config.ownerUsername}`)
  const stored = all.find((f) => f.endsWith('notes.txt'))!
  expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, stored))).digest('hex')).toBe(fileHash)
  await expect(exportHub(t.config, t.paths, path.join(t.paths.root, 'inside'))).rejects.toThrow(/outside the hub folder/)
})

test('uninstall lists before it acts, and keeps data unless told', async () => {
  const gone = hubPaths(path.join(work, 'restored'))
  const plan = await uninstall(null, gone, { execute: false, deleteData: true, repo: '/nowhere' })
  expect(plan.steps.find((s) => s.step === 'data')).toMatchObject({ done: false })
  expect(fs.existsSync(gone.root)).toBe(true)
  const kept = await uninstall(null, gone, { execute: true, deleteData: false, repo: '/nowhere' })
  expect(kept.steps.find((s) => s.step === 'data')?.detail).toMatch(/^kept/)
  expect(fs.existsSync(gone.root)).toBe(true)
  await uninstall(null, gone, { execute: true, deleteData: true, repo: '/nowhere' })
  expect(fs.existsSync(gone.root)).toBe(false)
  expect(plan.by_hand.join(' ')).toMatch(/certificate/)
})
