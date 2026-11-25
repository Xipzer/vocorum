// A forum channel (Discord's type 15): no messages of its own, only posts, each a thread.
// Shown as Discord does, a list of post cards newest activity first; a card opens its post.

import { useState } from 'react'
import { Avatar } from './Avatar.tsx'
import { api, type Channel, type HubState } from './api.ts'
import { Empty } from './Panels.tsx'
import { SearchField } from './Chat.tsx'
import { E } from './emoji.tsx'
import { Icon } from './icons.tsx'
import { ago } from './SettingsKit.tsx'
import { can, P } from './perms.ts'
import { snowflakeGt, store, useStore } from './store.ts'

const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n)

export function Forum({ channel, state, onMenu, onOpen, onSearch }: { channel: Channel; state: HubState; onMenu: () => void; onOpen: (id: string) => void; onSearch: () => void }) {
  const seen = useStore((d) => d.seen)
  const posts = state.threads
    .filter((t) => t.parent_id === channel.id)
    .sort((a, b) => Number(Boolean(a.thread_metadata?.archived)) - Number(Boolean(b.thread_metadata?.archived)) || snowflakeTime(b.last_message_id ?? b.id) - snowflakeTime(a.last_message_id ?? a.id))
  return (
    <section className="chat forum">
      <header className="chat-header">
        <button className="icon-button menu" onClick={onMenu} aria-label="Channels">
          <Icon name="back" size={22} className="phone-only" />
          <Icon name="sidebar" size={20} className="desk-only-icon" />
        </button>
        <div className="chat-titles">
          <div className="crumbs">
            <span className="chat-title">
              <Icon name="threads" size={18} className="title-icon" />
              <span className="title-text">
                <E>{channel.name}</E>
              </span>
            </span>
          </div>
          {channel.topic && <span className="chat-sub">{channel.topic}</span>}
        </div>
        <span className="chat-actions">
          <SearchField onSearch={onSearch} />
        </span>
      </header>
      <div className="forum-posts">
        {can(P.SEND_MESSAGES, channel) && <NewPost forum={channel} onOpen={onOpen} />}
        {posts.length === 0 ? (
          <Empty icon="threads" title="No posts yet">
            Posts in this forum show here, each with its own conversation.
          </Empty>
        ) : (
          posts.map((post) => {
            const owner = state.users.find((u) => u.id === post.owner_id)
            const last = post.last_message_id ?? post.id
            const unread = snowflakeGt(post.last_message_id, seen[post.id])
            return (
              <button key={post.id} className={`forum-post${post.thread_metadata?.archived ? ' archived' : ''}${unread ? ' unread' : ''}`} onClick={() => onOpen(post.id)}>
                <span className="forum-post-title">
                  <E>{post.name}</E>
                </span>
                <span className="forum-post-meta">
                  {owner && (
                    <span className="forum-post-owner">
                      <Avatar id={owner.id} name={owner.global_name ?? owner.username} size="inline" version={owner.avatar} />
                      <E>{owner.global_name ?? owner.username}</E>
                    </span>
                  )}
                  <span className="forum-post-count num">
                    <Icon name="chat" size={14} />
                    {post.message_count ?? 0}
                  </span>
                  <span className="num">{ago(snowflakeTime(last))}</span>
                  {post.thread_metadata?.archived && <span>Archived</span>}
                </span>
              </button>
            )
          })
        )}
      </div>
    </section>
  )
}

// Discord's "New post": a title and a first message; posting opens the new post.
function NewPost({ forum, onOpen }: { forum: Channel; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!open)
    return (
      <div className="forum-bar">
        <button className="button primary" onClick={() => setOpen(true)}>
          <Icon name="plus" size={16} />
          New post
        </button>
      </div>
    )
  const ready = name.trim() && content.trim() && !busy
  const post = () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    api
      .newPost(forum.id, { name: name.trim(), content: content.trim() })
      .then(({ thread }) => {
        store.apply('THREAD_CREATE', thread)
        onOpen(thread.id)
      })
      .catch((e: Error) => {
        setError(e.message)
        setBusy(false)
      })
  }
  return (
    <form
      className="forum-new"
      onSubmit={(e) => {
        e.preventDefault()
        post()
      }}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      <input className="settings-input forum-new-title" autoFocus maxLength={100} placeholder="Post title" aria-label="Post title" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        className="settings-input"
        rows={4}
        maxLength={2000}
        placeholder="Write the first message"
        aria-label="First message"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && post()}
      />
      {error && <div className="error">{error}</div>}
      <div className="forum-new-actions">
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!ready}>
          Post
        </button>
      </div>
    </form>
  )
}
