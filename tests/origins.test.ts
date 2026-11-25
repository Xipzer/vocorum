// message_origins with integer ids: older hubs' text-keyed table is copied over
// once, and 19-digit snowflakes come back exact.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { HubStore } from '../src/store.ts'

test('a text-keyed message_origins becomes integer-keyed, ids kept exactly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origins-'))
  const file = path.join(dir, 'hub.db')
  const old = new DatabaseSync(file)
  old.exec("CREATE TABLE message_origins (message_id TEXT PRIMARY KEY, origin TEXT NOT NULL, echo_of TEXT); CREATE INDEX message_origins_echo ON message_origins (echo_of)")
  old.exec("INSERT INTO message_origins VALUES ('1999999999999999840', 'discord', NULL), ('1999999999999999841', 'echo', '1999999999999999839')")
  old.close()
  const store = new HubStore(`file:${file}`)
  await store.migrate()
  await store.migrate()
  const columns = (await store.db.execute('PRAGMA table_info(message_origins)')).rows
  expect(columns.find((c) => c['name'] === 'message_id')?.['type']).toBe('INTEGER')
  const rows = (await store.db.execute('SELECT CAST(message_id AS TEXT) AS id, origin, CAST(echo_of AS TEXT) AS echo FROM message_origins ORDER BY message_id')).rows
  expect(rows).toEqual([
    { id: '1999999999999999840', origin: 'discord', echo: null },
    { id: '1999999999999999841', origin: 'echo', echo: '1999999999999999839' },
  ])
  // Text ids in queries still match the integer keys.
  expect((await store.db.execute({ sql: 'SELECT origin FROM message_origins WHERE message_id = ?', args: ['1999999999999999841'] })).rows[0]?.['origin']).toBe('echo')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
