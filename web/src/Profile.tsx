// A member's profile card, as Discord's popout: banner, avatar with presence, name, what
// they are doing, and the member menu's actions as buttons. A bottom sheet on phones.

import type { User } from './api.ts'
import { Avatar, machineIcon } from './Avatar.tsx'
import { E } from './emoji.tsx'
import { Icon, type IconName } from './icons.tsx'
import { sessionActions, type SheetAt, type SheetSpec } from './Sheet.tsx'
import { plain, wallHue } from './text.ts'
import { agentName, store, useStore } from './store.ts'
import './profile.css'

export type ProfileOf = { user: User; machine?: string | null }
type Action = { label: string; icon: IconName; run: () => void }

export function profileSheet(of: ProfileOf, at: SheetAt, channelId: string | null): SheetSpec {
  const title = of.machine ? agentName(store.data.state?.machine_bots, of.machine) : (of.user.global_name ?? of.user.username)
  return { title, at, groups: [], card: (finish) => <ProfileCard of={of} channelId={channelId} finish={finish} /> }
}

function ProfileCard({ of, channelId, finish }: { of: ProfileOf; channelId: string | null; finish: (run: () => void) => void }) {
  const state = useStore((d) => d.state)
  const typing = useStore((d) => (channelId ? d.typing[channelId]?.[of.user.id] : undefined))
  if (!state) return null
  const { user, machine } = of
  const p = state.presence?.[user.id]
  const me = user.id === state.me.id
  const running = machine ? p?.machines?.find((m) => m.machine.toLowerCase() === machine.toLowerCase()) : undefined
  const status = machine ? (running?.online ? 'online' : 'offline') : (p?.status ?? (me ? 'online' : 'offline'))
  const name = machine ? agentName(state.machine_bots, machine) : (user.global_name ?? user.username)
  const hue = user.color != null && !machine ? `#${user.color.toString(16).padStart(6, '0')}` : `rgb(${wallHue(machine ?? user.username)})`
  const where = (id: string | null) => {
    if (!id) return 'Overview'
    if (id === channelId) return 'here'
    const c = [...state.channels, ...state.threads].find((x) => x.id === id)
    return c ? (state.threads.some((t) => t.id === id) ? plain(c.name ?? '') : `#${c.name}`) : 'elsewhere'
  }
  const working = (typing ?? 0) > Date.now()
  // Where Discord lists roles: an agent's machine and what it is doing, a person's devices.
  const chips: Array<{ dot: string; text: string }> = user.bot
    ? [
        ...(machine ? [{ dot: status, text: machine }] : []),
        { dot: working || running?.activity || p?.activity ? 'busy' : 'none', text: working ? 'Working here' : (running?.activity ?? (machine ? null : p?.activity) ?? (status === 'offline' ? 'Offline' : 'Idle')) },
      ]
    : (p?.devices ?? []).map((d) => ({ dot: d.visible ? 'online' : 'idle', text: `${d.name}${d.visible ? '' : ' (away)'} · ${where(d.channel_id)}` }))
  const presence = user.bot ? null : user.pending ? 'Not joined yet' : status === 'online' ? 'Online' : status === 'idle' ? 'Idle' : 'Offline'
  const openDm = (to: { recipient_id: string }) => void store.openDm(to).then((c) => (location.hash = `#/c/${c.id}`)).catch(() => {})
  const actions: Action[] = [
    ...(!user.bot && !me && state.private_channels ? [{ label: 'Message', icon: 'chat' as const, run: () => openDm({ recipient_id: user.id }) }] : []),
    ...(me && sessionActions.settings ? [{ label: 'Edit Profile', icon: 'pencil' as const, run: () => sessionActions.settings?.('account') }] : []),
    machine ? { label: 'Copy machine name', icon: 'copy', run: () => void navigator.clipboard?.writeText(machine) } : { label: 'Copy user ID', icon: 'copy', run: () => void navigator.clipboard?.writeText(user.id) },
  ]
  return (
    <>
      <div className="profile-banner" style={{ background: hue }} />
      <div className="profile-avatar">
        <Avatar id={user.id} name={name} size="panel" version={user.avatar} src={machine ? machineIcon(state.machine_icons, machine, 'avatar') : null} />
        <i className={`presence ${status}`} aria-label={status} />
      </div>
      <div className="profile-body">
        <div className="profile-name"><E>{name}</E></div>
        <div className="profile-user">
          {user.username}
          {user.bot && <span className="bot-tag">BOT</span>}
        </div>
        {presence && <div className="profile-presence">{presence}</div>}
        {chips.length > 0 && (
          <div className="profile-chips" aria-label={user.bot ? 'Machine and state' : 'Devices'}>
            {chips.map((c) => (
              <span key={c.text} className="profile-chip"><i className={`chip-dot ${c.dot}`} />{c.text}</span>
            ))}
          </div>
        )}
        <div className="profile-actions">
          {actions.map((a, i) => (
            <button key={a.label} className={`button${i === 0 ? ' primary' : ''}`} onClick={() => finish(a.run)}>
              <Icon name={a.icon} size={16} />
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
