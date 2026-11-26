import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import type { Message } from '../web/src/api.ts'
import { isToolOnly, stepLines, stepText } from '../web/src/steps.ts'

const fixture: Record<string, string[]> = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/kimaki-steps.json'), 'utf8'))
const bot = (content: string, i: number) => ({ id: String(i), content, author: { id: '1', username: 'kimaki', bot: true }, attachments: [], embeds: [], components: [], timestamp: '2026-08-01T10:00:00Z', type: 0 }) as unknown as Message

for (const [era, contents] of Object.entries(fixture)) {
  test(`tool lines written ${era} fold into one run between the agent's text`, () => {
    const messages = contents.map(bot)
    expect(messages.map(isToolOnly)).toEqual([false, true, true, true, true, true, false])
    const lines = stepLines(messages.slice(1, 6))
    expect(lines).toHaveLength(6)
    expect(lines.every((l) => l.startsWith('-# '))).toBe(true)
    expect(stepText(lines.at(-1)!)).toMatch(/^(bash|shell) Run the map check again$/)
  })
}

test('text, attachments and messages from people are never steps', () => {
  expect(isToolOnly(bot('┣ bash _ls_\nThen the summary.', 0))).toBe(false)
  expect(isToolOnly(bot('Bullet ┣ in prose', 0))).toBe(false)
  expect(isToolOnly({ ...bot('┣ bash _ls_', 0), author: { id: '2', username: 'alice' } } as unknown as Message)).toBe(false)
  expect(isToolOnly({ ...bot('┣ bash _ls_', 0), attachments: [{ id: '1', filename: 'a.png' }] } as unknown as Message)).toBe(false)
})
