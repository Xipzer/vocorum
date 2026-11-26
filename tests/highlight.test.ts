import { expect, test } from 'vitest'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { highlight } from '../web/src/highlight.tsx'

const html = (lang: string, code: string) => renderToStaticMarkup(createElement(Fragment, null, highlight(lang, code)))

test('typescript: keywords, strings, numbers, calls and comments get their classes; words inside identifiers do not', () => {
  const out = html('ts', "const important = load('x', 42) // note")
  expect(out).toContain('<span class="tk-kw">const</span>')
  expect(out).toContain('important')
  expect(out).not.toContain('<span class="tk-kw">import</span>')
  expect(out).toContain('<span class="tk-fn">load</span>')
  expect(out).toContain('<span class="tk-str">&#x27;x&#x27;</span>')
  expect(out).toContain('<span class="tk-num">42</span>')
  expect(out).toContain('<span class="tk-com">// note</span>')
})

test('diff and ansi blocks colour like Discord', () => {
  expect(html('diff', '+added\n-removed\n context')).toMatch(/diff-add">\+added[\s\S]*diff-del">-removed/)
  expect(html('ansi', '\u001b[31mred\u001b[0m plain')).toContain('color:#dc322f')
})

test('unknown languages stay plain text', () => {
  expect(html('brainfuck', '+++')).toBe('+++')
})

test('agent prose: ids, paths, durations and key= are marked by kind', async () => {
  const { inline } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null } as never
  const out = renderToStaticMarkup(createElement(Fragment, null, inline('run finished in ses_1234567890abcdefFAKEid0000 after 13m 15s, 311213 tokens; wrote web/src/styles.css at commit 9f4ab0c, mode=fast', ctx)))
  expect(out).toContain('<span class="sem-id">ses_1234567890abcdefFAKEid0000</span>')
  expect(out).toContain('<span class="sem-num">13m 15s</span>')
  expect(out).toContain('<span class="sem-num">311213 tokens</span>')
  expect(out).toContain('<span class="sem-path">web/src/styles.css</span>')
  expect(out).toContain('<span class="sem-id">9f4ab0c</span>')
  expect(out).toContain('<span class="sem-key">mode=</span>')
})

test('status lines become one gutter column; tool rows keep their timing on the right', async () => {
  const { Markdown } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null } as never
  const out = renderToStaticMarkup(createElement(Markdown, { ctx, text: ['💭 checking the logs', '🔧 `pnpm test` in web → 134 passed (694 ms)', '✅ build passed in 27.3s', '⛔ deploy cancelled', '✋ waiting for review'].join('\n') }))
  for (const tone of ['think', 'tool', 'ok', 'bad', 'info']) expect(out).toContain(`status-row ${tone}`)
  expect(out).toContain('<span class="status-time num">694 ms</span>')
})

test('markdown blocks: footers, raw callouts, mixed lists, jumbo emoji, mentions', async () => {
  const { Markdown } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null, role: () => ({ name: 'mods', color: 0xff0000 }) } as never
  const out = (text: string) => renderToStaticMarkup(createElement(Markdown, { ctx, text }))
  expect(out('*proj ⋅ master ⋅ 7m 16s ⋅ 19% ⋅ model*')).toContain('meta-line')
  expect(out('-# *master ⋅ 2s ⋅ 3% ⋅ claude*')).toContain('meta-line')
  expect(out('*just italic*')).not.toContain('meta-line')
  expect(out('<callout accent="#ef4444">\n## Title\nbody\n</callout>')).toContain('--bar:#ef4444')
  expect(out('- a\n1. b')).toMatch(/<ul>[\s\S]*<\/ul><ol/)
  expect(out('🎉🔥')).toContain('markdown jumbo')
  expect(out('🎉 ok')).not.toContain('jumbo')
  const m = out('<@&1> @everyone </model:2> <id:customize> me@here.com')
  expect(m).toContain('@mods')
  expect(m).toContain('@everyone')
  expect(m).toContain('/model')
  expect(m).toContain('Channels &amp; Roles')
  expect(m).not.toContain('>@here<')
})

test('kimaki tool lines and relays', async () => {
  const { Markdown } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null } as never
  const out = renderToStaticMarkup(createElement(Markdown, { ctx, text: '┣ shell _Build the docs site_\n┣ general **Tidy the changelog** (background)' }))
  expect(out).toContain('<div class="subtext step-line tool-shell"><span class="step-glyph">┣ </span><span class="step-tool">shell</span> <em>Build the docs site</em></div>')
  expect(out.replace(/<[^>]+>/g, '')).toContain('┣ shell Build the docs site')
  expect(out).not.toContain('status-row')
  const failed = renderToStaticMarkup(createElement(Markdown, { ctx, text: '-#  ⨯  shell _Run the map check_' }))
  expect(failed).toContain('<div class="subtext step-line tool-shell failed"><span class="step-glyph">⨯  </span><span class="step-tool">shell</span>')
  const relay = renderToStaticMarkup(createElement(Markdown, { ctx, text: 'Now the tools.\n-# » **CLI:** From the other thread\n-# - **Search is live**\n-# - more' }))
  expect(relay).toContain('class="relay"')
  expect(relay).toContain('CLI:')
})

test('pipe tables render as tables with numeric columns right-aligned', async () => {
  const { Markdown } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null } as never
  const out = renderToStaticMarkup(createElement(Markdown, { ctx, text: '| Bucket | Alerts |\n|---|---|\n| 2 or more | 697 |\n| None | 8,018 |' }))
  expect(out).toContain('<table class="kv-table md-table">')
  expect(out).toMatch(/text-align:right">697/)
})

test('markdown source keeps every character for copying and marks what it means', () => {
  const src = '# Title\n\nSome **bold**, *it*, `code` and [a link](https://x.y).\n- item\n> quote\n```ts\nconst a = 1\n```\n| a | b |\n|---|---|\n| 1 | 2 |'
  const out = html('md', src)
  expect(out.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).toBe(src)
  expect(out).toContain('class="md-h md-h1"')
  expect(out).toContain('<span class="md-strong"><span class="md-mark">**</span>bold')
  expect(out).toContain('class="md-link">a link')
  expect(out).toContain('<span class="md-bullet">-</span>')
  expect(out).toContain('<span class="tk-kw">const</span>')
})

test('blank lines between blocks keep Discord\'s empty line, except before headings', async () => {
  const { Markdown } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null } as never
  const out = (text: string) => renderToStaticMarkup(createElement(Markdown, { ctx, text }))
  expect(out('The draft now reads:\n\n> Dear Alex,\n> Kind regards')).toMatch(/paragraph[\s\S]*md-gap[\s\S]*<blockquote/)
  expect(out('Intro\n\n## Heading')).not.toContain('md-gap')
  expect(out('one\n\ntwo')).not.toContain('md-gap')
  expect(out('```\ncode\n```\n\nafter')).toMatch(/codeblock[\s\S]*md-gap[\s\S]*after/)
})

test('files Discord deleted render as a tile and never load an empty url', async () => {
  const { Attachments } = await import('../web/src/Media.tsx')
  const out = renderToStaticMarkup(createElement(Attachments, { attachments: [
    { id: '1', filename: 'shot.png', size: 2048, url: '', proxy_url: '', content_type: 'image/png', missing: true },
    { id: '2', filename: 'notes.txt', size: 10, url: '', missing: true },
  ] }))
  expect(out).toContain('Image no longer available · 2')
  expect(out).toContain('File no longer available')
  expect(out).not.toMatch(/src=""|href=""/)
})

test('a dotted file name is one path token', async () => {
  const { inline } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null } as never
  expect(renderToStaticMarkup(createElement(Fragment, null, inline('wrote cluster.test.ts and src/a.b.config.ts', ctx)))).toBe('wrote <span class="sem-path">cluster.test.ts</span> and <span class="sem-path">src/a.b.config.ts</span>')
})

test('words joined by slashes stay prose; only real paths get the path style', async () => {
  const { inline } = await import('../web/src/markdown.tsx')
  const ctx = { userName: () => null, channelName: () => null } as never
  const render = (text: string) => renderToStaticMarkup(createElement(Fragment, null, inline(text, ctx)))
  // The owner's own sentences: no part of them is a path.
  for (const prose of [
    'a few freezes/stalls/hitches whilst typing',
    'do you know why/when/how these occurred',
    'yes/no/maybe, and/or, he/she/they',
    'due 25/11/2026 at 24/7 pace',
    'see example.org/harbour/timetable and @scope/pkg/sub',
    'either /stalls/hitches or nothing...',
  ]) expect(render(prose)).not.toContain('sem-path')
  const path = (p: string) => `<span class="sem-path">${p}</span>`
  expect(render('open ./run.sh then ../notes and ~/code/kimaki')).toBe(`open ${path('./run.sh')} then ${path('../notes')} and ${path('~/code/kimaki')}`)
  expect(render('read /home/harbour/ledger and /var/log/')).toBe(`read ${path('/home/harbour/ledger')} and ${path('/var/log/')}`)
  expect(render('wrote /harbour/ledger.csv (see /client/auth/register)')).toBe(`wrote ${path('/harbour/ledger.csv')} (see ${path('/client/auth/register')})`)
  expect(render('edited why/when/how.md and web/src/styles.css')).toBe(`edited ${path('why/when/how.md')} and ${path('web/src/styles.css')}`)
})
