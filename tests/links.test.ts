import { expect, test } from 'vitest'
import { extractRefs } from '../src/links.ts'

test('references: thread links, channel mentions, CLI flags, session IDs and the spawn footer', () => {
  const refs = extractRefs(
    [
      'see https://discord.com/channels/1100000000000000000/1200000000000000001 and <#1200000000000000002>',
      "kimaki send --thread 1200000000000000003 --prompt 'x'",
      'kimaki session read 1200000000000000004 > out.md',
      'talk to ses_0123456789abcdefABCDEFghij',
    ].join('\n'),
    JSON.stringify([{ footer: { text: 'start: true\nparentSessionId: ses_9876543210zyxwvuZYXWVUtsrq' } }]),
  )
  expect(refs).toEqual([
    { thread: '1200000000000000001' },
    { thread: '1200000000000000002' },
    { thread: '1200000000000000003' },
    { thread: '1200000000000000004' },
    { session: 'ses_0123456789abcdefABCDEFghij' },
    { session: 'ses_9876543210zyxwvuZYXWVUtsrq', parent: true },
  ])
  expect(extractRefs('no refs here, ses_short', '[]')).toEqual([])
})

test('the from-marker Kimaki adds to a prompt sent from another machine', () => {
  expect(extractRefs('Please check the schema\n-# from desktop · thread 1200000000000000009 · session ses_abcdefghijklmnopqrstuvwxyz', '[]')).toEqual([{ thread: '1200000000000000009' }, { session: 'ses_abcdefghijklmnopqrstuvwxyz' }])
  expect(extractRefs('Hi\n-# from homelab · session ses_abcdefghijklmnopqrstuvwxyz', '[]')).toEqual([{ session: 'ses_abcdefghijklmnopqrstuvwxyz' }])
})
