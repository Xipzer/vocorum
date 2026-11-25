// Search, the mentions inbox and pins through the client API, against a
// discord.js bot: the index follows creates, edits and deletes live.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { AttachmentBuilder, Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { ftsExpression, parseQuery, snippet } from '../src/search.ts'
import { pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let phone: TestDevice
let general: TextChannel

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('laptop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  phone = await pairedDevice(t.hub)
  const state = await phone.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

const search = async (q: string) => {
  await t.hub.search.flush()
  return phone.json(`/client/search?q=${encodeURIComponent(q)}`)
}

test('query parsing', () => {
  const query = parseQuery('footer "short turns" from:Kimaki in:#general has:file before:2026-12-01 mentions:me')
  expect(query).toMatchObject({ text: ['footer'], phrases: ['short turns'], from: ['kimaki'], in: ['general'], has: ['file'], mentionsMe: true })
  expect(query.before).toBe(Date.parse('2026-12-01T00:00:00Z'))
  expect(ftsExpression(query)).toBe('"footer"* AND "short turns"')
  expect(ftsExpression(parseQuery('a"); DROP TABLE x; --'))).toBe('"a"* AND "DROP"* AND "TABLE"* AND "x"*')
})

test('search finds text, phrases, components and files, with filters, and follows edits and deletes', async () => {
  const thread = await general.threads.create({ name: 'Footer fix' })
  const answer = await thread.send('The reducer skipped turns with no text, so the footer went missing.')
  await general.send({ flags: 1 << 15, components: [{ type: 17, accent_color: 0xf59e0b, components: [{ type: 10, content: 'Deploy of kimaki.dev failed: timeout' }] }] } as never)
  await general.send({ content: 'diagram', files: [new AttachmentBuilder(Buffer.from('png'), { name: 'architecture-flow.png' })] })
  await phone.json(`/client/channels/${general.id}/messages`, { method: 'POST', json: { content: 'why is the footer missing?' } })

  expect((await search('footer')).total).toBe(2)
  expect((await search('foot')).total).toBe(2)
  const phrase = await search('"no text"')
  expect(phrase.results.map((r: { message: { id: string } }) => r.message.id)).toEqual([answer.id])
  expect(phrase.results[0].channel).toMatchObject({ id: thread.id, name: 'Footer fix', parent_id: general.id })
  expect(phrase.results[0].snippet).toContain('**no text**')
  expect((await search('deploy timeout')).total).toBe(1)
  expect((await search('architecture')).total).toBe(1)
  expect((await search('has:file')).total).toBe(1)
  expect((await search('footer from:me')).total).toBe(1)
  expect((await search('footer from:Kimaki')).total).toBe(1)
  expect((await search(`footer in:${thread.id}`)).total).toBe(1)
  // A channel scope includes its threads.
  expect((await search('footer in:#general')).total).toBe(2)
  expect((await search('footer before:2000-01-01')).total).toBe(0)

  await answer.edit('Rewritten answer about the reducer only.')
  expect((await search('"no text"')).total).toBe(0)
  expect((await search('rewritten')).total).toBe(1)
  await answer.delete()
  expect((await search('rewritten')).total).toBe(0)
  expect((await search('')).total).toBe(0)
})

test('mentions of the owner reach the inbox and the unread counts', async () => {
  const owner = t.config.ownerUserId
  const ask = await general.send(`<@${owner}> the migration needs your decision`)
  await t.hub.search.flush()
  const inbox = await phone.json('/client/inbox')
  expect(inbox.mentions[0]).toMatchObject({ message: { id: ask.id }, channel: { id: general.id }, read: false })
  expect((await phone.json('/client/state')).mentions[general.id]).toBe(1)
  expect((await search('mentions:me')).total).toBe(1)
  await phone.fetch('/client/read', { method: 'PUT', json: { read: { [general.id]: ask.id } } })
  expect((await phone.json('/client/state')).mentions[general.id]).toBeUndefined()
  expect((await phone.json('/client/inbox')).mentions[0].read).toBe(true)
})

test('pins: the owner and bots pin, the list follows, and has:pin searches them', async () => {
  const note = await general.send('Project note: deploy with pnpm release')
  await phone.json(`/client/channels/${general.id}/pins/${note.id}`, { method: 'PUT' })
  const pinned = await phone.json(`/client/channels/${general.id}/pins`)
  expect(pinned.messages.map((m: { id: string; pinned: boolean }) => [m.id, m.pinned])).toEqual([[note.id, true]])
  const system = await waitFor(async () => (await phone.json(`/client/channels/${general.id}/messages`)).messages.find((m: { type: number }) => m.type === 6))
  expect(system.message_reference.message_id).toBe(note.id)
  expect((await search('has:pin deploy')).total).toBe(1)

  const botNote = await general.send('Bot pinned this')
  await botNote.pin()
  const fetched = await general.messages.fetchPins()
  expect(fetched.items.map((p) => p.message.id).sort()).toEqual([note.id, botNote.id].sort())
  await botNote.unpin()
  await phone.json(`/client/channels/${general.id}/pins/${note.id}`, { method: 'DELETE' })
  expect((await phone.json(`/client/channels/${general.id}/pins`)).messages).toEqual([])
})

test('the index is rebuilt from the twin after a restart', async () => {
  await t.hub.store.db.execute('DELETE FROM message_index')
  await t.hub.store.db.execute('DELETE FROM message_fts')
  await t.hub.store.db.execute('DELETE FROM search_meta')
  await t.hub.search.start()
  expect((await search('migration decision')).total).toBe(1)
})

test('an index from before version 4 (a copy of the text, text ids) is replaced, and searches still work', async () => {
  t.hub.search.stop()
  const db = t.hub.store.db
  for (const table of ['message_index', 'message_fts', 'message_mentions']) await db.execute(`DROP TABLE IF EXISTS ${table}`)
  await db.execute('CREATE TABLE message_index (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, bot INTEGER NOT NULL, ts INTEGER NOT NULL, has_file INTEGER NOT NULL, has_image INTEGER NOT NULL, has_link INTEGER NOT NULL, mentions_owner INTEGER NOT NULL, pinned INTEGER NOT NULL)')
  await db.execute("CREATE VIRTUAL TABLE message_fts USING fts5(body, message_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')")
  await db.execute("INSERT INTO message_fts (rowid, body, message_id) VALUES (1, 'stale text', '1')")
  await db.execute("UPDATE search_meta SET value = '3' WHERE key = 'version'")
  ;(t.hub.search as unknown as { stopped: boolean }).stopped = false
  await t.hub.search.start()
  await t.hub.search.flush()
  const columns = (await db.execute('PRAGMA table_info(message_index)')).rows.map((r) => String(r['name']))
  expect(columns).toContain('id')
  expect(columns).not.toContain('mentions_owner')
  expect((await db.execute("SELECT sql FROM sqlite_master WHERE name = 'message_fts'")).rows[0]!['sql']).toMatch(/content=''/)
  expect((await search('stale')).total).toBe(0)
  const found = await search('migration decision')
  expect(found.total).toBe(1)
  expect(found.results[0].snippet).toMatch(/\*\*migration\*\*/)
})

test('snippets mark prefix hits and phrases, and cut long text around the first hit', () => {
  expect(snippet('Deployed the hub and ran the tests', parseQuery('deploy test'))).toBe('**Deployed** the hub and ran the **tests**')
  expect(snippet('it said no text here', parseQuery('"no text"'))).toBe('it said **no text** here')
  expect(snippet('Café opened', parseQuery('cafe'))).toBe('**Café** opened')
  expect(snippet('1. **Redirects file** at the host. 2. **Copy pages**', parseQuery('redirect'))).toBe('1. **Redirects** file at the host. 2. Copy pages')
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
  const cut = snippet(long, parseQuery('w40'))!
  expect(cut.startsWith('…')).toBe(true)
  expect(cut.endsWith('…')).toBe(true)
  expect(cut).toContain('**w40**')
  expect(cut.split(' ').length).toBe(16)
})
