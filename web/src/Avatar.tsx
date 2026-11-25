// A user's picture from the hub (/client/avatars/:id), or their initial when there is none.
// `version` is the user's avatar hash: a new one refetches. Without one (pictures set
// before the hub kept hashes) it still tries, and falls back to the initial on a 404.

import { useEffect, useState } from 'react'
import { dmName, dmUser, useStore } from './store.ts'
import type { Channel } from './api.ts'

// Pictures that 404'd, so they show initials without asking again. Cleared on reconnect:
// a request that failed while the hub restarted deserves another go.
const missing = new Set<string>()
export function forgetMissingImages() {
  missing.clear()
}

export function Avatar({ id, name, size, version, src: override }: { id: string; name: string; size: 'inline' | 'panel'; version?: string | null; src?: string | null }) {
  const src = override ?? `/client/avatars/${id}${version ? `?v=${version}` : ''}`
  const [failed, setFailed] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [retry, setRetry] = useState(0)
  const online = useStore((d) => d.online)
  // Back online: anything that didn't finish (a request cut by a hub restart) loads again.
  useEffect(() => {
    if (!online) return
    if (!loaded) {
      setFailed(null)
      setRetry((n) => n + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online])
  if (failed === src || missing.has(src)) return <span className={`avatar ${size}`}>{name.slice(0, 1).toUpperCase()}</span>
  const url = retry > 1 ? `${src}${src.includes('?') ? '&' : '?'}r=${retry}` : src
  return (
    <img
      className={`avatar ${size}${loaded ? '' : ' loading'}`}
      src={url}
      alt=""
      decoding="async"
      loading={size === 'inline' ? 'lazy' : 'eager'}
      onLoad={() => setLoaded(true)}
      onError={() => {
        missing.add(src)
        setFailed(src)
      }}
    />
  )
}

// A machine's picture (its Discord bot avatar or server icon), matched case-insensitively.
export function machineIcon(icons: Record<string, { avatar: string | null; guild_icon: string | null }> | undefined, machine: string | null | undefined, kind: 'avatar' | 'guild_icon'): string | null {
  if (!icons || !machine) return null
  const key = Object.keys(icons).find((k) => k.toLowerCase() === machine.toLowerCase())
  const hash = key ? icons[key]![kind] : null
  return hash ? `/client/machine-icons/${encodeURIComponent(key!)}/${kind}?v=${hash}` : null
}

// The picture for a direct message: the person's avatar, or the machine's bot picture.
export function DmAvatar({ channel, size }: { channel: Channel; size: 'inline' | 'panel' }) {
  const state = useStore((d) => d.state)
  const me = state?.me.id ?? ''
  const user = dmUser(channel, me)
  const name = dmName(channel, me)
  if (channel.machine) return <Avatar id={user?.id ?? channel.id} name={name} size={size} src={machineIcon(state?.machine_icons, channel.machine, 'avatar') ?? undefined} version={user?.avatar} />
  return <Avatar id={user?.id ?? channel.id} name={name} size={size} version={user?.avatar} />
}
