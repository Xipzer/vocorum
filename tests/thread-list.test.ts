import { expect, test } from 'vitest'
import type { Channel } from '../web/src/api.ts'
import { indexThreads } from '../web/src/thread-list.ts'

const hour = 3_600_000
const now = Date.UTC(2025, 5, 1)
const id = (at: number, seq = 0) => (((BigInt(at) - 1420070400000n) << 22n) + BigInt(seq)).toString()
const parent = id(now - 24 * hour)
const make = (at: number, minutes = 60, seq = 0): Channel => ({ id: id(at, seq), type: 11, parent_id: parent, thread_metadata: { archived: false, auto_archive_duration: minutes } })
const shown = (threads: Channel[], at = now) => {
  const list = indexThreads(threads, at)
  return list.byParent.get(parent)!.filter(t => list.visible.has(t.id)).map(t => t.id)
}

test('a reply brings a quiet thread back to its own place; more replies never move it', () => {
  const quiet = make(now - 8 * hour), newer = make(now - hour / 2), newest = make(now - hour / 2, 60, 1)
  const threads = [quiet, newest, newer]
  expect(shown(threads)).toEqual([newest.id, newer.id])
  quiet.last_message_id = id(now)
  expect(shown(threads)).toEqual([newest.id, newer.id, quiet.id])
  newer.last_message_id = id(now, 1)
  expect(shown(threads)).toEqual([newest.id, newer.id, quiet.id])
})

test('each thread gets its own inactivity window; reopening counts and archiving hides it', () => {
  const short = make(now - 2 * hour), long = make(now - 2 * hour, 1440, 1)
  expect(shown([short, long])).toEqual([long.id])
  short.thread_metadata!.archive_timestamp = new Date(now).toISOString()
  expect(indexThreads([short, long], now).nextExpiry).toBe(now + hour)
  expect(shown([short, long])).toEqual([long.id, short.id])
  expect(shown([short, long], now + hour)).toEqual([long.id])
  long.thread_metadata!.archived = true
  expect(shown([short, long], now + hour)).toEqual([])
})

test('a channel can reopen every quiet thread at once without displacing any from the sidebar', () => {
  const threads = Array.from({ length: 128 }, (_, i) => make(now - 48 * hour, 1440, i))
  expect(shown(threads)).toEqual([])
  for (const t of threads) t.thread_metadata!.archive_timestamp = new Date(now).toISOString()
  expect(shown(threads)).toEqual([...threads].reverse().map(t => t.id))
})
