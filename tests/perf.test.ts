// The stall log times the script an event costs and keeps only names, durations and sizes.
// A test clock stands in for the page's, so machine load cannot change the result.
import { expect, test } from 'vitest'
import { eventApplied, eventSettled, measured, perfLog, useClock } from '../web/src/perf.ts'

let now = 0
useClock(() => now)
// The log reads the clock in the task its own message port queues. Wait for that signal, not a
// timer: a timer and a port message are not ordered, so under load a timer can run first.

test('a slow event is logged under its type with its duration; quick ones are only counted', async () => {
  eventApplied('TYPING_START')
  now += 4
  await measured()
  eventApplied('MESSAGE_CREATE')
  now += 30 // the update and its render
  eventSettled()
  eventApplied('PRESENCE_UPDATE') // same task: timed together under the first
  eventSettled()
  await Promise.resolve()
  now += 40 // then layout, paint or a delay before the next task
  await measured()
  const { totals, slow } = perfLog()
  expect(totals['TYPING_START']).toMatchObject({ n: 1, ms: 4, max: 4, slow: 0 })
  expect(totals['PRESENCE_UPDATE']).toBeUndefined()
  expect(totals['MESSAGE_CREATE']).toMatchObject({ n: 1, ms: 70, max: 70, slow: 1 })
  expect(slow).toHaveLength(1)
  expect(slow[0]).toMatchObject({ type: 'MESSAGE_CREATE', ms: 70, script: 30, batch: 2 })
  expect(Object.keys(slow[0]!).sort()).toEqual(['at', 'batch', 'hidden', 'ms', 'nodes', 'page', 'script', 'type'])
})
