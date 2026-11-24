import { describe, expect, test } from 'vitest'
import { deriveState, machineName, type LiteMessage } from '../src/sessions.ts'

const OWNER = '100'
const BOT = '200'
let id = 1000
const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 24, 12, 0) - minutesAgo * 60_000).toISOString()
const NOW = Date.UTC(2026, 10, 24, 12, 0)
const owner = (content: string, ago = 10): LiteMessage => ({ id: String(id++), authorId: OWNER, bot: false, type: 0, content, components: [], attachments: [], timestamp: at(ago) })
const bot = (content: string, extra: Partial<LiteMessage> = {}, ago = 5): LiteMessage => ({ id: String(id++), authorId: BOT, bot: true, type: 0, content, components: [], attachments: [], timestamp: at(ago), ...extra })
const buttons = (...labels: string[]) => [{ type: 1, components: labels.map((label, i) => ({ type: 2, style: i === 0 ? 3 : 2, label, custom_id: `b${i}` })) }]
const FOOTER = '-# *project ⋅ main ⋅ 2m 30s ⋅ 31% ⋅ model*'

describe('deriveState', () => {
  test('a turn that ends with a footer is done', () => {
    expect(deriveState([owner('fix it'), bot('-# ┣ read *a.ts*'), bot(`Fixed.\n${FOOTER}`)], OWNER, { now: NOW }).state).toBe('done')
  })

  test('live buttons wait for the owner and carry their choices', () => {
    const result = deriveState([owner('fix it'), bot('Commit changes?', { components: buttons('Commit', 'Other') })], OWNER, { now: NOW })
    expect(result.state).toBe('waiting')
    expect(result.ask?.text).toBe('Commit changes?')
    expect(result.ask?.choices?.map((c) => c.label)).toEqual(['Commit', 'Other'])
  })

  test('a question followed by a footer still waits', () => {
    expect(deriveState([owner('go'), bot('**Question:** which one?', { components: [{ type: 1, components: [{ type: 3, custom_id: 's', options: [] }] }] }), bot(FOOTER)], OWNER, { now: NOW }).state).toBe('waiting')
  })

  test('the owner answering clears an older question', () => {
    const result = deriveState([owner('go', 20), bot('Commit?', { components: buttons('Commit') }, 15), owner('yes, commit', 3)], OWNER, { now: NOW })
    expect(result.state).toBe('busy')
  })

  test('disabled buttons do not wait', () => {
    const disabled = [{ type: 1, components: [{ type: 2, style: 3, label: 'Commit', custom_id: 'c', disabled: true }] }]
    expect(deriveState([owner('go'), bot(`Done\n${FOOTER}`, { components: disabled })], OWNER, { now: NOW }).state).toBe('done')
  })

  test('a mention of the owner waits; risky or draft choices are open-only', () => {
    expect(deriveState([owner('go'), bot(`<@${OWNER}> please check`)], OWNER, { now: NOW }).state).toBe('waiting')
    const risky = deriveState([owner('go'), bot('Send it?', { components: buttons('Send', 'Edit first') })], OWNER, { now: NOW })
    expect(risky.ask?.choices).toBeUndefined()
    expect(risky.ask?.openOnly).toBe(true)
    const draft = deriveState([owner('go'), bot('Draft below', { attachments: [{ filename: 'reply.md' }] }), bot('Happy with it?', { components: buttons('Yes', 'No') })], OWNER, { now: NOW })
    expect(draft.ask?.openOnly).toBe(true)
  })

  test('a permission request waits, and sudo is open-only', () => {
    const permission = [{ type: 17, accent_color: 0x8b5cf6, components: [{ type: 10, content: '**Permission required**\n`sudo systemctl restart x`' }, ...buttons('Accept', 'Reject')] }]
    const result = deriveState([owner('go'), bot('', { components: permission })], OWNER, { now: NOW })
    expect(result.state).toBe('waiting')
    expect(result.ask?.openOnly).toBe(true)
  })

  test('a red callout fails', () => {
    const red = [{ type: 17, accent_color: 0xef4444, components: [{ type: 10, content: '`vllm serve` crashed' }] }]
    const result = deriveState([owner('go'), bot('', { components: red })], OWNER, { now: NOW })
    expect(result.state).toBe('failed')
    expect(result.error).toBe('vllm serve crashed')
  })

  test('tool lines without a footer are busy, with the last step', () => {
    const result = deriveState([owner('go'), bot('-# ┣ read *a.ts*\n-# ┣ shell _pnpm test_')], OWNER, { now: NOW })
    expect(result.state).toBe('busy')
    expect(result.lastStep).toBe('shell pnpm test')
  })

  test('typing is busy; a fresh prompt with no reply is busy; an old done turn is idle', () => {
    expect(deriveState([owner('go'), bot(`ok\n${FOOTER}`)], OWNER, { now: NOW, typingUntil: NOW + 5000 }).state).toBe('busy')
    expect(deriveState([owner('go', 2)], OWNER, { now: NOW }).state).toBe('busy')
    expect(deriveState([owner('go', 60 * 24 * 9), bot(`ok\n${FOOTER}`, {}, 60 * 24 * 8)], OWNER, { now: NOW }).state).toBe('idle')
  })
})

test('a footer that pings the owner is done, not waiting; week-old asks and hour-old runs are idle', () => {
  const ping = `> *project ⋅ 12s ⋅ 4% ⋅ model* <@${OWNER}>`
  expect(deriveState([owner('go'), bot('Answer'), bot(ping)], OWNER, { now: NOW }).state).toBe('done')
  expect(deriveState([owner('go', 60 * 24 * 9), bot('Commit?', { components: buttons('Commit') }, 60 * 24 * 8)], OWNER, { now: NOW }).state).toBe('idle')
  expect(deriveState([owner('go', 120), bot('-# ┣ read *a.ts*', {}, 90)], OWNER, { now: NOW }).state).toBe('idle')
})

test('machineName: registered bots and Kimaki categories are machines, others are not', () => {
  expect(machineName('desktop', ['desktop'])).toBe('desktop')
  expect(machineName('Kimaki Homelab')).toBe('Homelab')
  expect(machineName('Text Channels')).toBeNull()
})
