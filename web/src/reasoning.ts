// What the client can see of an agent's reasoning. Kimaki posts a live
// "-# thinking · 12s · <headline>" line while the model reasons, edits it every
// few seconds as the headline changes, and deletes it when the thought ends.
// History therefore keeps nothing: the trail here is only what this page saw
// arrive, held in memory and lost on reload.

import { useSyncExternalStore } from 'react'
import type { Message } from './api.ts'
import { store } from './store.ts'

const THINK = /^-# \*?thinking · (\d+)s(?: · (.+?))?\*?$/
const KEEP = 20

export type Thought = { id: string; seconds: number; headlines: string[]; live: boolean }

const trails = new Map<string, Thought[]>()
const listeners = new Set<() => void>()
let version = 0

function touch() {
  version++
  for (const listener of listeners) listener()
}

function record(channelId: string, list: Message[]) {
  const trail = trails.get(channelId) ?? []
  let changed = false
  const seen = new Set<string>()
  for (const m of list.slice(-30)) {
    const match = m.author.bot && THINK.exec(m.content.trim())
    if (!match) continue
    seen.add(m.id)
    const seconds = Number(match[1])
    const headline = match[2]?.trim()
    let thought = trail.find((t) => t.id === m.id)
    if (!thought) {
      thought = { id: m.id, seconds, headlines: [], live: true }
      trail.push(thought)
      changed = true
    }
    if (thought.seconds !== seconds) { thought.seconds = seconds; changed = true }
    if (headline && thought.headlines.at(-1) !== headline) { thought.headlines.push(headline); changed = true }
  }
  // A live line that left the list was deleted: the thought ended.
  for (const thought of trail) if (thought.live && !seen.has(thought.id)) { thought.live = false; changed = true }
  if (!changed) return
  trails.set(channelId, trail.slice(-KEEP).map((t) => ({ ...t, headlines: [...t.headlines] })))
  touch()
}

let last: unknown = null
store.subscribe(() => {
  const messages = store.data.messages
  if (messages === last) return
  last = messages
  for (const [channelId, entry] of Object.entries(messages)) if (entry?.list) record(channelId, entry.list)
})

export function useThoughts(channelId: string): Thought[] {
  useSyncExternalStore((l) => { listeners.add(l); return () => void listeners.delete(l) }, () => version)
  return trails.get(channelId) ?? []
}

const KEY = 'vocorum.workspace.reasoning'
export const reasoningShown = () => localStorage.getItem(KEY) === '1'
export const showReasoning = (on: boolean) => { localStorage.setItem(KEY, on ? '1' : '0'); touch() }
