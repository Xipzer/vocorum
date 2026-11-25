// Unicode emoji drawn as Twemoji images (CC-BY 4.0, web/public/emoji), as Discord does: the
// same look on every system, even one with no emoji font. Each glyph is its own small file,
// fetched only when it is first shown. Form fields can't hold images; they fall back to the
// Twemoji font in styles.css.

import { useState, type ReactNode } from 'react'
import { api, type CustomEmojiInfo } from './api.ts'

const DIR = '/emoji/twemoji-17'

// Recommended emoji (sequences, flags, keycaps, skin tones) where the browser knows the set;
// a close approximation elsewhere.
const PATTERN = (() => {
  try {
    return new RegExp('\\p{RGI_Emoji}', 'gv')
  } catch {
    return /(?:\p{RI}\p{RI}|[#*0-9]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{EMod}?(?:\u200D(?:\p{Extended_Pictographic}\uFE0F?)\p{EMod}?)*)/gu
  }
})()

// The vendored files are named by code points without U+FE0F.
export const emojiUrl = (emoji: string) =>
  `${DIR}/${[...emoji]
    .map((ch) => ch.codePointAt(0)!)
    .filter((cp) => cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join('-')}.svg`

export function Emoji({ emoji, className }: { emoji: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className={`emoji-text${className ? ` ${className}` : ''}`}>{emoji}</span>
  return <img className={`emoji${className ? ` ${className}` : ''}`} src={emojiUrl(emoji)} alt={emoji} draggable={false} loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

// A server's own emoji (<:name:id>), served by the hub: it keeps working after a server
// leaves Discord, and Discord never learns who looks at it. Its name shows if it's missing.
export function CustomEmoji({ name, id, jumbo }: { name: string; id: string; jumbo?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <>{`:${name}:`}</>
  return <img className={`emoji${jumbo ? ' jumbo' : ''}`} src={`/client/emojis/${id}`} alt={`:${name}:`} title={`:${name}:`} draggable={false} loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

const CUSTOM = /<a?:(\w+):(\d+)>/g

// Text with its emoji as images, custom ones included; plain text comes back unchanged.
export function emojify(text: string, key = 'e', className?: string): ReactNode[] {
  if (!text.includes('<')) return unicode(text, key, className)
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(CUSTOM)) {
    if (m.index > last) out.push(...unicode(text.slice(last, m.index), `${key}u${n}`, className))
    out.push(<CustomEmoji key={`${key}c${n++}`} name={m[1]!} id={m[2]!} />)
    last = m.index + m[0].length
  }
  if (last === 0) return unicode(text, key, className)
  if (last < text.length) out.push(...unicode(text.slice(last), `${key}u${n}`, className))
  return out
}

function unicode(text: string, key: string, className?: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(PATTERN)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<Emoji key={`${key}${n++}`} emoji={m[0]} className={className} />)
    last = m.index + m[0].length
  }
  if (last === 0) return [text]
  if (last < text.length) out.push(text.slice(last))
  return out
}


export const customTag = (e: CustomEmojiInfo) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`
export const customName = (tag: string) => /^<a?:(\w+):\d+>$/.exec(tag)?.[1] ?? null

// A server's emoji, fetched once per server.
const servers = new Map<string, Promise<CustomEmojiInfo[]>>()
export function serverEmoji(guildId: string | undefined): Promise<CustomEmojiInfo[]> {
  if (!guildId) return Promise.resolve([])
  let list = servers.get(guildId)
  if (!list) {
    list = api.guildEmojis(guildId).catch(() => {
      servers.delete(guildId)
      return []
    })
    servers.set(guildId, list)
  }
  return list
}

// ":name:" typed or picked in the composer becomes the server's emoji when sent, as on
// Discord. Code spans and blocks are left alone.
export async function expandEmoji(text: string, guildId: string | undefined) {
  if (!/:\w+:/.test(text)) return text
  const byName = new Map((await serverEmoji(guildId)).map((e) => [e.name, e]))
  if (!byName.size) return text
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<![<\w]):(\w{2,64}):(?!\d)/g, (m, name: string) => (byName.has(name) ? customTag(byName.get(name)!) : m))))
    .join('')
}

// For names and labels: <E>{name}</E>.
export function E({ children }: { children: string | null | undefined }) {
  return <>{children ? emojify(children) : children}</>
}

// Copying a selection with emoji images gives the emoji, not gaps: the browser leaves images
// out of copied text. Line breaks come from the rendered layout, as in a normal copy.
export function installEmojiCopy() {
  document.addEventListener('copy', (e) => {
    const selection = getSelection()
    if (!selection || selection.isCollapsed || !e.clipboardData || !selection.rangeCount) return
    const fragment = selection.getRangeAt(0).cloneContents()
    if (!fragment.querySelector('img.emoji')) return
    for (const img of fragment.querySelectorAll<HTMLImageElement>('img.emoji')) img.replaceWith(img.alt)
    const holder = document.createElement('div')
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;white-space:pre-wrap;opacity:0;pointer-events:none'
    holder.append(fragment)
    document.body.append(holder)
    e.clipboardData.setData('text/plain', holder.innerText)
    e.clipboardData.setData('text/html', holder.innerHTML)
    holder.remove()
    e.preventDefault()
  })
}
