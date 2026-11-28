// Who reacted, as Discord shows it: a reaction's tooltip names the first few people, and the
// Reactions list (a dialog on desktop, a sheet on phones) lists everyone under each emoji.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type User } from './api.ts'
import { Avatar, machineIcon } from './Avatar.tsx'
import { emojify } from './emoji.tsx'
import type { SheetSpec } from './Sheet.tsx'
import { agentName, store, useStore } from './store.ts'
import { displayName } from './text.ts'

export type ReactionSummary = { emoji: string; count: number; me: boolean }

const TIP_NAMES = 3
const PAGE = 100

// Discord names an emoji by its shortcode; standard ones here take their Unicode name.
let names: Promise<Map<string, string>> | null = null
export async function emojiName(emoji: string): Promise<string> {
  const custom = /^<a?:(\w+):\d+>$/.exec(emoji)
  if (custom) return `:${custom[1]}:`
  names ??= import('./emoji-data.ts').then((m) => new Map(m.EMOJI_GROUPS.flatMap((g) => g.emoji)))
  const name = (await names).get(emoji) ?? (await names).get(emoji.replace(/\uFE0F/g, ''))
  return name ? `:${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}:` : emoji
}

// A bot reacts as its machine: that machine's name and picture.
function useWho() {
  const bots = useStore((d) => d.state?.machine_bots)
  const icons = useStore((d) => d.state?.machine_icons)
  const users = useStore((d) => d.state?.users)
  return (u: User) => {
    const machine = u.bot ? Object.keys(bots ?? {}).find((k) => bots![k]!.discord_user_id === u.id) : undefined
    const known = users?.find((x) => x.id === u.id)
    return { name: machine ? agentName(bots, machine) : displayName(known ?? u), avatar: known?.avatar ?? u.avatar, src: u.bot ? machineIcon(icons, machine, 'avatar') : null }
  }
}

const tipCache = new Map<string, Promise<User[]>>()

export function ReactionTip({ channelId, messageId, reaction, anchor }: { channelId: string; messageId: string; reaction: ReactionSummary; anchor: DOMRect }) {
  const who = useWho()
  const [users, setUsers] = useState<User[] | null>(null)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    const key = `${messageId} ${reaction.emoji} ${reaction.count} ${reaction.me}`
    let list = tipCache.get(key)
    if (!list) tipCache.set(key, (list = api.reactors(channelId, messageId, reaction.emoji, undefined, TIP_NAMES)))
    list.then((u) => live && setUsers(u), () => tipCache.delete(key))
    void emojiName(reaction.emoji).then((n) => live && setName(n))
    return () => void (live = false)
  }, [channelId, messageId, reaction.emoji, reaction.count, reaction.me])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const half = el.offsetWidth / 2
    const x = anchor.left + anchor.width / 2
    const left = Math.min(Math.max(x, half + 8), window.innerWidth - half - 8)
    el.style.left = `${left}px`
    el.style.setProperty('--arrow', `${x - left}px`)
  })
  if (!users || !name) return null
  const shown = users.map((u) => who(u).name)
  const others = reaction.count - shown.length
  const people = others > 0 ? `${shown.join(', ')} and ${others} other${others === 1 ? '' : 's'}` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0]
  return createPortal(
    <div ref={ref} className="tip reaction-tip" role="tooltip" style={{ left: anchor.left + anchor.width / 2, top: anchor.top }}>
      <span className="reaction-tip-emoji">{emojify(reaction.emoji, 't')}</span>
      <span>
        {people} reacted with {name}
      </span>
    </div>,
    document.body,
  )
}

export function reactionsSheet(channelId: string, messageId: string, reactions: ReactionSummary[], first: string): SheetSpec {
  const phone = window.matchMedia('(max-width: 767px)').matches
  return {
    title: 'Reactions',
    groups: [],
    cardClass: 'reactions-sheet',
    at: phone ? undefined : { x: window.innerWidth / 2 - 220, y: window.innerHeight / 2 - 200 },
    card: () => <ReactionsList channelId={channelId} messageId={messageId} reactions={reactions} first={first} />,
  }
}

function ReactionsList({ channelId, messageId, reactions, first }: { channelId: string; messageId: string; reactions: ReactionSummary[]; first: string }) {
  const who = useWho()
  const [current, setCurrent] = useState(first)
  const [lists, setLists] = useState<Record<string, User[]>>({})
  const loading = useRef(new Set<string>())
  const count = reactions.find((r) => r.emoji === current)?.count ?? 0
  const list = lists[current]
  const more = (emoji: string, after?: string) => {
    if (loading.current.has(emoji)) return
    loading.current.add(emoji)
    api.reactors(channelId, messageId, emoji, after, PAGE).then(
      (page) => setLists((l) => ({ ...l, [emoji]: after ? [...(l[emoji] ?? []), ...page] : page })),
      (e: Error) => store.notice(e.message),
    ).finally(() => loading.current.delete(emoji))
  }
  useEffect(() => {
    if (!lists[current]) more(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])
  const scrolled = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    if (list && list.length < count && list.length % PAGE === 0 && el.scrollTop + el.clientHeight > el.scrollHeight - 200) more(current, list.at(-1)!.id)
  }
  return (
    <div className="reactions-list">
      <div className="reactions-tabs" role="tablist" aria-label="Reactions">
        {reactions.map((r) => (
          <button key={r.emoji} role="tab" aria-selected={r.emoji === current} className={`reactions-tab${r.emoji === current ? ' on' : ''}`} onClick={() => setCurrent(r.emoji)}>
            <span className="reaction-emoji">{emojify(r.emoji, 'r')}</span>
            <span className="num">{r.count}</span>
          </button>
        ))}
      </div>
      <ul className="reactions-users" role="tabpanel" onScroll={scrolled} onPointerDown={(e) => e.stopPropagation()}>
        {list?.map((u) => {
          const { name, avatar, src } = who(u)
          return (
            <li key={u.id} className="reactions-user">
              <Avatar id={u.id} name={name} size="inline" version={avatar} src={src} />
              <span className="reactions-name">{name}</span>
              {u.bot ? <span className="bot-tag">BOT</span> : name !== u.username && <span className="reactions-username">{u.username}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
