import fs from 'node:fs'
import path from 'node:path'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { emojify } from '../web/src/emoji.tsx'

test('ASCII labels need no Unicode emoji scan, including text around custom emoji', () => {
  const scan = vi.spyOn(RegExp.prototype, Symbol.matchAll)
  try {
    const inputs = ['', '123 # *', 'a < b', '\x00\t\n\x7f']
    const plain = inputs.map((s) => emojify(s))
    const custom = emojify('a <:wave:42> b <a:spin:43> c')
    const uncachedUnicodeScans = scan.mock.contexts.filter((r) => r instanceof RegExp && /RGI_Emoji|Emoji_Presentation/.test(r.source)).length
    expect(uncachedUnicodeScans).toBe(0)
    expect(plain).toEqual(inputs.map((s) => [s]))
    const html = renderToStaticMarkup(createElement(Fragment, null, custom))
    expect(html).toMatch(/^a <img[^>]+src="\/client\/emojis\/42"[^>]*\/> b <img[^>]+src="\/client\/emojis\/43"[^>]*\/> c$/)
  } finally {
    scan.mockRestore()
  }
})

test('keycaps, flags, joined emoji and non-emoji Unicode retain their rendering', () => {
  const text = 'café 漢字 1️⃣ #️⃣ 🇬🇧 👩🏽‍💻.'
  const html = renderToStaticMarkup(createElement(Fragment, null, emojify(text, 'row', 'jumbo')))
  expect(html).toContain('café 漢字 ')
  for (const [glyph, name] of [['1️⃣', '31-20e3'], ['#️⃣', '23-20e3'], ['🇬🇧', '1f1ec-1f1e7'], ['👩🏽‍💻', '1f469-1f3fd-200d-1f4bb']]) {
    expect(html).toContain(`src="/emoji/twemoji-17/${name}.svg" alt="${glyph}"`)
  }
  expect(html.match(/class="emoji jumbo"/g)).toHaveLength(4)
})

// The pattern is hand-written for speed (see emoji.tsx). It must find exactly what the exact
// set finds: every vendored image in each of its recommended spellings, alone, inside prose
// and doubled, and nothing among ordinary characters.
test('the fast pattern matches the recommended set for every vendored emoji and no other character', () => {
  const exact = new RegExp('\\p{RGI_Emoji}', 'gv')
  const found = (nodes: ReturnType<typeof emojify>) => nodes.filter((n) => typeof n !== 'string').map((n) => (n as { props: { emoji: string } }).props.emoji)
  const dir = path.resolve(import.meta.dirname, '../web/public/emoji/twemoji-17')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg'))
  let checked = 0
  for (const file of files) {
    const parts = file.slice(0, -4).split('-').map((hex) => String.fromCodePoint(parseInt(hex, 16)))
    for (let mask = 0; mask < 1 << Math.min(parts.length, 8); mask++) {
      const emoji = parts.map((c, i) => c + ((mask >> i) & 1 ? '\uFE0F' : '')).join('')
      const whole = emoji.match(exact)
      if (whole?.length !== 1 || whole[0] !== emoji) continue
      checked++
      for (const text of [emoji, `x${emoji}y`, emoji + emoji, `\u2014${emoji}\u2192`]) expect(found(emojify(text)), file).toEqual(text.match(exact))
    }
  }
  expect(checked).toBeGreaterThan(3900)
  for (let cp = 0x80; cp <= 0x1ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const text = `a${String.fromCodePoint(cp)}b`
    if (found(emojify(text)).length !== (text.match(exact)?.length ?? 0)) throw new Error(`U+${cp.toString(16)} differs from the recommended set`)
  }
  expect(found(emojify('done \u2014 93/93 \u2192 \u201cok\u201d \u2713'))).toEqual([])
})
