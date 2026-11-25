// Settings like Discord's: a full-screen layer with grouped sections on the left
// and one section on the right (Esc or the close button leaves). On phones it is
// a list that pushes a section, like Discord on iOS. Two layers share the shell:
// user and server settings, and one channel's settings (Discord's Edit Channel).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LoadingMark } from './components.tsx'
import { createPortal } from 'react-dom'
import { api, type Channel, type DeviceInfo, type HubState, type NotifyLevel, type User } from './api.ts'
import { applyAccent } from './App.tsx'
import { resetColumns, useColumns } from './columns.ts'
import { Icon } from './icons.tsx'
import { disablePush, effective, enablePush, pushSupported } from './notify.ts'
import { sessionActions } from './Sheet.tsx'
import { store, THREAD_TYPES, useStore } from './store.ts'
import { plain } from './text.ts'
import { ago, Confirm, currentGuild, Feedback, Group, hex, ImagePicker, Item, message, mutedText, Page, Pending, Radios, Switch, TextSetting, useFeedback } from './SettingsKit.tsx'
import { ChannelPermissionsPage, MembersPage, PairDevice, RolesPage, ServerPermissionsPage } from './SettingsPeople.tsx'
import { can, P } from './perms.ts'
import './settings.css'

const IMAGE_LIMIT = 4 * 1024 * 1024
const HOUR = 3_600_000
const FOREVER = 100 * 365 * 24 * HOUR
const LEVELS: Array<{ id: NotifyLevel; label: string; note: string }> = [
  { id: 'all', label: 'All messages', note: 'Every new message notifies you.' },
  { id: 'mentions', label: 'Only mentions', note: 'Only messages that mention you.' },
  { id: 'nothing', label: 'Nothing', note: 'No notifications.' },
]
const LEVEL_TEXT: Record<NotifyLevel, string> = { all: 'All messages', mentions: 'Only mentions', nothing: 'Nothing' }
const CHANNEL_TYPES: Array<{ id: 0 | 5 | 15; label: string }> = [
  { id: 0, label: 'Text' },
  { id: 5, label: 'Announcement' },
  { id: 15, label: 'Forum' },
]

type NavItem = { id: string; label: string; red?: boolean; run?: () => void }
type NavGroup = { heading?: string; items: NavItem[] }

const PHONE = '(max-width: 767px)'
function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches)
  useEffect(() => {
    const query = window.matchMedia(PHONE)
    const on = () => setPhone(query.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [])
  return phone
}

// --- the shell

function Shell({ label, groups, section, onSection, title, onClose, children }: { label: string; groups: NavGroup[]; section: string | null; onSection: (id: string | null) => void; title: string; onClose: () => void; children: ReactNode }) {
  const phone = usePhone()
  const layer = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const close = () => {
    if (history.state?.settings) history.back()
    else closeRef.current()
  }

  // Modal: the app behind is inert, phone Back and Esc leave, focus comes back after.
  useEffect(() => {
    const root = document.getElementById('root')
    const before = document.activeElement as HTMLElement | null
    root?.setAttribute('inert', '')
    history.pushState({ settings: true }, '')
    const onPop = () => closeRef.current()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('keydown', onKey, true)
    return () => {
      root?.removeAttribute('inert')
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onKey, true)
      before?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus into the layer: the current section's nav item, or on phones the page's back button.
  useEffect(() => {
    const el = layer.current
    if (!el) return
    const target = el.querySelector<HTMLElement>(phone ? '.settings-phone-head button' : '[aria-current="page"]') ?? el.querySelector<HTMLElement>('button')
    target?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, phone ? section : null])

  const items = groups.flatMap((g) => g.items)
  const pick = (item: NavItem) => (item.run ? item.run() : onSection(item.id))

  if (phone)
    return createPortal(
      <div ref={layer} className="settings-layer phone" role="dialog" aria-modal="true" aria-label={label}>
        {section === null ? (
          <div className="settings-push">
            <header className="settings-phone-head">
              <button className="icon-button" onClick={close} aria-label={`Close ${label.toLowerCase()}`}>
                <Icon name="close" />
              </button>
              <h1>{label}</h1>
              <span />
            </header>
            <div className="settings-phone-list">
              {groups.map((group, i) => (
                <section key={i}>
                  {group.heading && <h2 className="settings-phone-heading">{group.heading}</h2>}
                  <div className="settings-phone-group">
                    {group.items.map((item) => (
                      <button key={item.id} className={`settings-phone-row${item.red ? ' red' : ''}`} onClick={() => pick(item)}>
                        <span>{item.label}</span>
                        {!item.run && <Icon name="chevron" size={18} />}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : (
          <div className="settings-push" key={section}>
            <header className="settings-phone-head">
              <button className="icon-button" onClick={() => onSection(null)} aria-label="Back">
                <Icon name="back" />
              </button>
              <h1>{items.find((i) => i.id === section)?.label ?? title}</h1>
              <span />
            </header>
            <div className="settings-content">{children}</div>
          </div>
        )}
      </div>,
      document.body,
    )

  return createPortal(
    <div ref={layer} className="settings-layer" role="dialog" aria-modal="true" aria-label={label}>
      <div className="settings-side">
        <nav className="settings-nav" aria-label={`${label} sections`}>
          {groups.map((group, i) => (
            <div key={i} className="settings-nav-group">
              {group.heading && <div className="settings-nav-head">{group.heading}</div>}
              {group.items.map((item) => (
                <button key={item.id} className={`settings-nav-item${item.red ? ' red' : ''}`} aria-current={item.id === section ? 'page' : undefined} onClick={() => pick(item)}>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>
      <div className="settings-main">
        <div className="settings-content" key={section}>
          {children}
        </div>
        <div className="settings-tools">
          <button className="settings-close" onClick={close} aria-label={`Close ${label.toLowerCase()}`} title="Close (Esc)">
            <Icon name="close" size={18} />
          </button>
          <span aria-hidden="true">Esc</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// --- user settings

function AccountPage({ state }: { state: HubState }) {
  const me = state.users.find((u) => u.id === state.me.id)
  const name = me?.global_name ?? me?.username ?? 'You'
  // The picked colour before it is saved; null when untouched.
  const [color, setColor] = useState<string | null>(null)
  const current = me?.color != null ? hex(me.color) : null
  const avatar = useFeedback()
  const colour = useFeedback()
  const applyUser = (r: { user: User }) => store.apply('USER_UPDATE', r.user)
  const upload = (file: File) => {
    if (file.size > IMAGE_LIMIT) return avatar.set({ ok: false, text: 'Pick an image under 4 MB.' })
    void avatar.run(() => api.setAvatar(file).then(applyUser), 'Avatar updated.')
  }
  return (
    <Page title="My account">
      <div className="settings-profile">
        <span className="settings-profile-avatar">
          {me?.avatar ? <img src={`/client/avatars/${state.me.id}?v=${me.avatar}`} alt="" /> : <span>{name.slice(0, 1).toUpperCase()}</span>}
        </span>
        <span className="settings-profile-name">
          <b style={me?.color != null ? { color: hex(me.color) } : undefined}>{name}</b>
          <small>
            {me?.username} · {state.device.name}
          </small>
        </span>
      </div>
      <Group title="Profile">
        <TextSetting label="Display name" note="What people and bots see. Leave it empty to show your username." value={me?.global_name ?? ''} placeholder={me?.username} max={32} allowEmpty onSave={(v) => api.patchMe({ global_name: v || null }).then(applyUser)} />
        <Item label="Avatar" note="PNG, JPEG, GIF or WebP, up to 4 MB.">
          <div className="settings-actions">
            {me?.avatar && (
              <button className="button" onClick={() => void avatar.run(() => api.setAvatar(null).then(applyUser), 'Avatar removed.')}>
                Remove
              </button>
            )}
            <ImagePicker label={me?.avatar ? 'Change avatar' : 'Upload avatar'} onPick={upload} />
          </div>
        </Item>
        <Feedback text={avatar.text} />
        <Item label="Name colour" note="Your name is shown in this colour in messages and the member list.">
          <div className="settings-actions">
            <input className="settings-color" type="color" value={color ?? current ?? '#e3e3e9'} aria-label="Name colour" onChange={(e) => setColor(e.target.value)} />
            {color !== null && color !== current && (
              <button className="button primary" onClick={() => void colour.run(() => api.patchMe({ color: parseInt(color.slice(1), 16) }).then(applyUser).then(() => setColor(null)))}>
                Save colour
              </button>
            )}
            {current && (
              <button className="button" onClick={() => void colour.run(() => api.patchMe({ color: null }).then(applyUser).then(() => setColor(null)))}>
                Reset
              </button>
            )}
          </div>
        </Item>
        <Feedback text={colour.text} />
      </Group>
      <Group title="This device">
        <TextSetting label="Device name" note="How this device appears in Devices and to others on the hub." value={state.device.name} max={64} onSave={(v) => api.renameDevice(state.device.id, v).then(() => store.loadState())} />
      </Group>
    </Page>
  )
}

function DevicesPage() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const feedback = useFeedback()
  useEffect(() => {
    void feedback.run(async () => setDevices((await api.devices()).devices))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const revoke = (device: DeviceInfo) =>
    void feedback.run(async () => {
      const result = await api.revokeDevice(device.id)
      if (result.signed_out) return location.reload()
      setRevoking(null)
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null)
    }, `${device.name} is signed out.`)
  return (
    <Page title="Devices">
      <Group note="Every device paired with this hub. Signing one out ends its session and stops its notifications; it needs a new pairing code to come back.">
        {!devices && !feedback.text && (
          <div className="loading-inline">
            <LoadingMark size={28} />
          </div>
        )}
        <div className="settings-list">
          {devices?.map((d) => (
            <div key={d.id} className="settings-list-row">
              {renaming === d.id ? (
                <div className="settings-list-edit">
                  <TextSetting
                    label="Device name"
                    value={d.name}
                    max={64}
                    onSave={async (v) => {
                      setDevices((await api.renameDevice(d.id, v)).devices)
                      setRenaming(null)
                      if (d.current) void store.loadState()
                    }}
                  />
                  <button className="button" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </div>
              ) : revoking === d.id ? (
                <Confirm text={d.current ? 'Sign out this device? You will need a new pairing code.' : `Sign out ${d.name}? It will need a new pairing code.`} action="Sign out" onCancel={() => setRevoking(null)} onConfirm={() => revoke(d)} />
              ) : (
                <>
                  <i className={`settings-online${d.online ? ' on' : ''}`} aria-label={d.online ? 'Online' : 'Offline'} />
                  <div className="settings-item-text">
                    <div className="settings-label">
                      {d.name}
                      {d.current && <span className="settings-tag">This device</span>}
                    </div>
                    <div className="settings-item-note">
                      {d.online ? 'Online now' : `Last seen ${ago(d.last_seen_at)}`} · {d.push ? 'Notifications on' : 'Notifications off'} · Added {ago(d.created_at)}
                    </div>
                  </div>
                  <div className="settings-actions">
                    <button className="button" onClick={() => setRenaming(d.id)}>
                      Rename
                    </button>
                    <button className="button danger" onClick={() => setRevoking(d.id)}>
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <Feedback text={feedback.text} />
      </Group>
      <PairDevice />
    </Page>
  )
}

// A guild's own level: what channels and threads without a setting use.
function ServerDefault({ state, guildId, guildName }: { state: HubState; guildId: string; guildName: string }) {
  const n = state.notifications
  const feedback = useFeedback()
  const level = n?.settings[guildId]?.level ?? n?.default_level ?? 'mentions'
  return (
    <Group title="Server default" note={`Channels and threads in ${guildName} without their own setting use this.`}>
      <Radios name={`level-${guildId}`} label="Server default" value={level} options={LEVELS} onChange={(l) => void feedback.run(() => store.setNotification(guildId, { level: l }))} disabled={!n} />
      <Feedback text={feedback.text} />
    </Group>
  )
}

function scopeName(state: HubState, id: string): { name: string; where?: string } {
  const guild = store.guilds().find((g) => g.id === id)
  if (guild) return { name: guild.name, where: 'Server' }
  const c = store.channel(id)
  if (!c) return { name: 'A channel that no longer exists' }
  if (THREAD_TYPES.has(c.type)) return { name: plain(c.name ?? '') || 'untitled', where: `Thread in #${store.channel(c.parent_id ?? '')?.name ?? 'channel'}` }
  if (c.type === 4) return { name: c.name ?? '', where: 'Category' }
  return { name: `#${c.name}`, where: 'Channel' }
}

function Overrides({ state, guildId }: { state: HubState; guildId?: string }) {
  const n = state.notifications
  const now = Date.now()
  // The open server's own level and mute have their own controls above.
  const shownAbove = currentGuild(state).id
  const entries = Object.entries(n?.settings ?? {}).filter(([id, s]) => (s.level || (s.muted_until ?? 0) > now) && id !== shownAbove && (!guildId || store.guildOf(id) === guildId))
  return (
    <Group title="Custom settings" note="Channels and threads with their own level or mute. Reset one to follow its parent again.">
      {entries.length === 0 ? (
        <p className="settings-empty">Nothing has its own setting. Use the bell in a channel header, or Edit channel, to set one.</p>
      ) : (
        <div className="settings-list">
          {entries.map(([id, s]) => {
            const scope = scopeName(state, id)
            return (
              <div key={id} className="settings-list-row">
                <div className="settings-item-text">
                  <div className="settings-label">{scope.name}</div>
                  <div className="settings-item-note">{[scope.where, s.level ? LEVEL_TEXT[s.level] : null, mutedText(s.muted_until)].filter(Boolean).join(' · ')}</div>
                </div>
                <button className="button" onClick={() => void store.setNotification(id, { level: null, muted_until: null })} aria-label={`Reset ${scope.name}`}>
                  Reset
                </button>
              </div>
            )
          })}
        </div>
      )}
    </Group>
  )
}

function PushGroup({ state }: { state: HubState }) {
  const on = Boolean(state.notifications?.push_subscribed)
  const supported = pushSupported()
  const feedback = useFeedback()
  const [busy, setBusy] = useState(false)
  const toggle = async (next: boolean) => {
    setBusy(true)
    feedback.set(null)
    try {
      feedback.set({ ok: true, text: await (next ? enablePush() : disablePush()) })
    } catch (e) {
      feedback.set({ ok: false, text: message(e) })
    }
    setBusy(false)
  }
  return (
    <Group title="This device">
      <Item label="Push notifications" note={supported ? 'Notifications reach this device even when Vocorum is closed.' : 'This browser can’t receive push notifications. On iPhone, add Vocorum to the Home Screen first.'}>
        <Switch label="Push notifications on this device" checked={on} disabled={busy || (!supported && !on)} onChange={(v) => void toggle(v)} />
      </Item>
      {on && (
        <Item label="Test" note="Sends a notification to this device now.">
          <button className="button" onClick={() => void feedback.run(async () => {
            const r = await api.pushTest()
            if (!r.sent) throw new Error('The test could not be delivered.')
          }, 'Test sent to this device.')}>
            Send a test
          </button>
        </Item>
      )}
      <Feedback text={feedback.text} />
    </Group>
  )
}

function NotificationsPage({ state }: { state: HubState }) {
  const guild = currentGuild(state)
  return (
    <Page title="Notifications">
      <ServerDefault state={state} guildId={guild.id} guildName={guild.name} />
      <PushGroup state={state} />
      <Overrides state={state} />
    </Page>
  )
}

function AppearancePage() {
  const [accent, setAccent] = useState(localStorage.getItem('accent') === 'pink' ? 'pink' : 'cyan')
  const columns = useColumns()
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(query.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [])
  const pick = (value: 'cyan' | 'pink') => {
    setAccent(value)
    localStorage.setItem('accent', value)
    applyAccent(value)
  }
  const side = columns.side
  return (
    <Page title="Appearance">
      <Group title="Accent colour" note="Used for the selection, focus and primary buttons. Saved on this device.">
        <Radios
          name="accent"
          label="Accent colour"
          value={accent}
          onChange={(v) => pick(v as 'cyan' | 'pink')}
          options={[
            { id: 'cyan', label: 'Cyber cyan', swatch: 'var(--cyan)' },
            { id: 'pink', label: 'Hyper pink', swatch: 'var(--pink)' },
          ]}
        />
      </Group>
      <Group title="Layout">
        <Item label="Column widths" note={`Channel list ${side.collapsed ? 'folded' : `${side.width} px`}, server list ${columns.rail.collapsed ? 'folded' : 'open'}. Reset puts both back open at their default widths.`}>
          <button className="button" onClick={resetColumns}>
            Reset
          </button>
        </Item>
        <Item label="Reduced motion" note={reduced ? 'Your system asks for reduced motion, so animations are off.' : 'Follows your system setting, which currently allows animations.'} />
      </Group>
    </Page>
  )
}

function PrivacyPage({ state, server }: { state: HubState; server?: string }) {
  const privacy = state.privacy ?? { show_presence: true, show_activity: true }
  const feedback = useFeedback()
  const set = (body: { show_presence?: boolean; show_activity?: boolean }) => void feedback.run(() => api.patchMe(body).then(() => store.loadState()))
  return (
    <Page title={server ? 'Privacy settings' : 'Privacy'}>
      <Group note={server ? `These apply on every server on this hub, ${server} included.` : 'What other people on this hub see about you. Bots and the hub owner’s services are not affected.'}>
        <Item label="Show my status" note="Others see you as online or away. Off, you always look offline.">
          <Switch label="Show my status" checked={privacy.show_presence} disabled={!state.privacy} onChange={(v) => set({ show_presence: v })} />
        </Item>
        <Item label="Show where I am" note="Others see which channel you have open, and only channels they can see themselves.">
          <Switch label="Show where I am" checked={privacy.show_activity} disabled={!state.privacy || !privacy.show_presence} onChange={(v) => set({ show_activity: v })} />
        </Item>
        <Feedback text={feedback.text} />
      </Group>
    </Page>
  )
}

// --- server settings

function ServerPage({ state }: { state: HubState }) {
  const guild = currentGuild(state)
  const allowed = can(P.MANAGE_GUILD, null, guild.id)
  const icon = useFeedback()
  const applyGuild = (g: { id: string; name: string; icon?: string | null }) => store.apply('GUILD_UPDATE', g)
  const upload = (file: File) => {
    if (file.size > IMAGE_LIMIT) return icon.set({ ok: false, text: 'Pick an image under 4 MB.' })
    void icon.run(() => api.setGuildIcon(guild.id, file).then(applyGuild), 'Icon updated.')
  }
  return (
    <Page title="Server overview">
      <Group note={allowed ? undefined : 'You need Manage server to change these.'}>
        <div className="settings-server">
          <span className="settings-server-icon">{guild.icon ? <img src={`/client/guild-icons/${guild.id}?v=${guild.icon}`} alt="" /> : <span>{guild.name.slice(0, 1).toUpperCase()}</span>}</span>
          <div className="settings-item-text">
            <div className="settings-label">Server icon</div>
            <div className="settings-item-note">PNG, JPEG, GIF or WebP, up to 4 MB. Square works best.</div>
            <div className="settings-actions">
              <ImagePicker label={guild.icon ? 'Change icon' : 'Upload icon'} onPick={upload} disabled={!allowed} />
              {guild.icon && allowed && (
                <button className="button" onClick={() => void icon.run(() => api.setGuildIcon(guild.id, null).then(applyGuild), 'Icon removed.')}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
        <Feedback text={icon.text} />
        <TextSetting label="Server name" value={guild.name} max={100} disabled={!allowed} onSave={(v) => api.patchGuild(guild.id, { name: v }).then(applyGuild)} />
      </Group>
    </Page>
  )
}

function CreateChannel({ guildId, categories, category, onDone }: { guildId: string; categories: Channel[]; category: boolean; onDone: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<0 | 5 | 15>(0)
  const [parent, setParent] = useState('')
  const [secret, setSecret] = useState(false)
  const feedback = useFeedback()
  const me = store.data.state?.me.id ?? ''
  // Private: @everyone can't view it, you can; add roles or members in its Permissions.
  const permission_overwrites = secret ? [{ id: guildId, type: 0 as const, allow: '0', deny: String(P.VIEW_CHANNEL) }, { id: me, type: 1 as const, allow: String(P.VIEW_CHANNEL), deny: '0' }] : undefined
  const create = () =>
    void feedback.run(async () => {
      const channel = await api.createChannel(guildId, category ? { name: name.trim(), type: 4, permission_overwrites } : { name: name.trim(), type, parent_id: parent || null, permission_overwrites })
      store.apply('CHANNEL_CREATE', channel)
      onDone()
    })
  return (
    <form
      className="settings-create"
      aria-label={category ? 'Create category' : 'Create channel'}
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) create()
      }}
    >
      <div className="settings-heading">{category ? 'Create category' : 'Create channel'}</div>
      <label className="settings-field">
        <span className="settings-label">{category ? 'Category name' : 'Channel name'}</span>
        <input className="settings-input" value={name} maxLength={100} autoFocus placeholder={category ? 'New category' : 'new-channel'} onChange={(e) => setName(e.target.value)} />
        {!category && <span className="settings-item-note">Lower case with dashes: “My Project” becomes my-project.</span>}
      </label>
      {!category && (
        <div className="settings-two">
          <label className="settings-field">
            <span className="settings-label">Type</span>
            <select className="settings-input" value={type} onChange={(e) => setType(Number(e.target.value) as 0 | 5 | 15)}>
              {CHANNEL_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-label">Category</span>
            <select className="settings-input" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <Item label={category ? 'Private category' : 'Private channel'} note="Only you can see it at first. Add roles or members in its Permissions.">
        <Switch label={category ? 'Private category' : 'Private channel'} checked={secret} onChange={setSecret} />
      </Item>
      <Feedback text={feedback.text} />
      <div className="settings-actions">
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!name.trim()}>
          Create
        </button>
      </div>
    </form>
  )
}

function ChannelsPage({ state }: { state: HubState }) {
  const guild = currentGuild(state)
  const [creating, setCreating] = useState<'channel' | 'category' | null>(null)
  const feedback = useFeedback()
  const inGuild = (c: Channel) => (c.guild_id ?? state.guild.id) === guild.id
  const byPosition = (a: Channel, b: Channel) => (a.position ?? 0) - (b.position ?? 0)
  const categories = state.channels.filter((c) => c.type === 4 && inGuild(c)).sort(byPosition)
  const channels = state.channels.filter((c) => c.type !== 4 && inGuild(c)).sort(byPosition)
  const groups = [{ category: null as Channel | null, list: channels.filter((c) => !c.parent_id || !categories.some((k) => k.id === c.parent_id)) }, ...categories.map((category) => ({ category, list: channels.filter((c) => c.parent_id === category.id) }))]
  const move = (list: Channel[], index: number, by: -1 | 1) =>
    void feedback.run(async () => {
      const next = [...list]
      const [item] = next.splice(index, 1)
      next.splice(index + by, 0, item!)
      const { channels: moved } = await api.reorderChannels(guild.id, next.map((c, i) => ({ id: c.id, position: i })))
      for (const c of moved) store.apply('CHANNEL_UPDATE', c)
    })
  const row = (c: Channel, list: Channel[], index: number) => (
    <div key={c.id} className={`settings-channel${c.type === 4 ? ' category' : ''}`}>
      {c.type !== 4 && <Icon name={c.type === 15 ? 'threads' : c.type === 5 ? 'feed' : 'hash'} size={18} />}
      <div className="settings-item-text">
        <div className="settings-label">{c.name}</div>
        {c.topic && <div className="settings-item-note">{c.topic}</div>}
      </div>
      <div className="settings-row-tools">
        <button className="icon-button" disabled={index === 0} onClick={() => move(list, index, -1)} aria-label={`Move ${c.name} up`} title="Move up">
          <Icon name="down" size={16} className="settings-up" />
        </button>
        <button className="icon-button" disabled={index === list.length - 1} onClick={() => move(list, index, 1)} aria-label={`Move ${c.name} down`} title="Move down">
          <Icon name="down" size={16} />
        </button>
        <button className="icon-button" onClick={() => sessionActions.channelSettings?.(c.id)} aria-label={`Edit ${c.name}`} title="Edit">
          <Icon name="gear" size={16} />
        </button>
      </div>
    </div>
  )
  return (
    <Page title="Channels">
      <Group note={`Channels and categories in ${guild.name}. Bots see every change through the gateway, as on Discord.`}>
        {creating ? (
          <CreateChannel guildId={guild.id} categories={categories} category={creating === 'category'} onDone={() => setCreating(null)} />
        ) : (
          <div className="settings-actions">
            <button className="button primary" onClick={() => setCreating('channel')}>
              Create channel
            </button>
            <button className="button" onClick={() => setCreating('category')}>
              Create category
            </button>
          </div>
        )}
        <Feedback text={feedback.text} />
      </Group>
      {groups.map(({ category, list }) =>
        !category && list.length === 0 ? null : (
          <section key={category?.id ?? 'none'} className="settings-channel-group" aria-label={category?.name ?? 'No category'}>
            {category ? row(category, categories, categories.indexOf(category)) : <div className="settings-channel-head">No category</div>}
            {list.map((c, i) => row(c, list, i))}
            {category && list.length === 0 && <p className="settings-empty">No channels in this category.</p>}
          </section>
        ),
      )}
    </Page>
  )
}

function ServerNotificationsPage({ state }: { state: HubState }) {
  const guild = currentGuild(state)
  const own = state.notifications?.settings[guild.id]
  const muted = mutedText(own?.muted_until ?? null)
  return (
    <Page title="Notification settings">
      <ServerDefault state={state} guildId={guild.id} guildName={guild.name} />
      <Group title="Mute server" note="A muted server sends no notifications, whatever its channels say.">
        <MuteControl scopeId={guild.id} muted={muted} label="Mute server" />
      </Group>
      <Overrides state={state} guildId={guild.id} />
    </Page>
  )
}

function MuteControl({ scopeId, muted, label }: { scopeId: string; muted: string | null; label: string }) {
  const feedback = useFeedback()
  const set = (until: number | null) => void feedback.run(() => store.setNotification(scopeId, { muted_until: until }))
  return (
    <>
      <Item label={muted ?? 'Not muted'}>
        {muted ? (
          <button className="button" onClick={() => set(null)}>
            Unmute
          </button>
        ) : (
          <select className="settings-input settings-select" aria-label={label} value="" onChange={(e) => e.target.value && set(Date.now() + Number(e.target.value))}>
            <option value="">Mute for…</option>
            <option value={15 * 60_000}>15 minutes</option>
            <option value={HOUR}>1 hour</option>
            <option value={8 * HOUR}>8 hours</option>
            <option value={24 * HOUR}>24 hours</option>
            <option value={FOREVER}>Until I turn it back on</option>
          </select>
        )}
      </Item>
      <Feedback text={feedback.text} />
    </>
  )
}

const USER_SECTIONS: NavItem[] = [
  { id: 'account', label: 'My account' },
  { id: 'devices', label: 'Devices' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'privacy', label: 'Privacy' },
]
const SERVER_SECTIONS: NavItem[] = [
  { id: 'server', label: 'Overview' },
  { id: 'channels', label: 'Channels' },
  { id: 'server-notifications', label: 'Notification settings' },
  { id: 'server-privacy', label: 'Privacy settings' },
  { id: 'roles', label: 'Roles' },
  { id: 'members', label: 'Members' },
  { id: 'permissions', label: 'Permissions' },
]
const ALIASES: Record<string, string> = { overview: 'server', profile: 'account', 'my-account': 'account' }
const toSection = (id?: string) => {
  const s = id ? (ALIASES[id] ?? id) : undefined
  return s && [...USER_SECTIONS, ...SERVER_SECTIONS].some((i) => i.id === s) ? s : null
}

export function Settings({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const state = useStore((d) => d.state)
  const phone = usePhone()
  const [picked, setPicked] = useState<string | null>(() => toSection(initial) ?? (window.matchMedia(PHONE).matches ? null : 'account'))
  if (!state) return null
  const section = picked ?? (phone ? null : 'account')
  const guild = currentGuild(state)
  const groups: NavGroup[] = [
    { heading: 'User settings', items: USER_SECTIONS },
    // Channels, roles and permissions only for people who may manage them, like Discord.
    { heading: guild.name, items: SERVER_SECTIONS.filter((i) => (i.id === 'channels' ? can(P.MANAGE_CHANNELS, null, guild.id) : i.id === 'roles' || i.id === 'permissions' ? can(P.MANAGE_ROLES, null, guild.id) : true)) },
    { items: [{ id: 'signout', label: 'Sign out', red: true, run: () => void api.logout().then(() => location.reload()) }] },
  ]
  const page =
    section === 'account' ? <AccountPage state={state} />
    : section === 'devices' ? <DevicesPage />
    : section === 'notifications' ? <NotificationsPage state={state} />
    : section === 'appearance' ? <AppearancePage />
    : section === 'privacy' ? <PrivacyPage state={state} />
    : section === 'server' ? <ServerPage state={state} />
    : section === 'channels' ? <ChannelsPage state={state} />
    : section === 'server-notifications' ? <ServerNotificationsPage state={state} />
    : section === 'server-privacy' ? <PrivacyPage state={state} server={guild.name} />
    : section === 'roles' ? <RolesPage state={state} />
    : section === 'members' ? <MembersPage state={state} />
    : section === 'permissions' ? <ServerPermissionsPage state={state} />
    : null
  return (
    <Shell label="Settings" groups={groups} section={section} onSection={setPicked} title="Settings" onClose={onClose}>
      {page}
    </Shell>
  )
}

// --- channel settings (Discord's Edit Channel)

// What a project channel says about its workspace: the folder in its topic, the
// machine its category is named after, and model or agent when the topic names one.
function workspace(state: HubState, channel: Channel) {
  const topic = channel.topic ?? ''
  const folder = /(?:^|\s)((?:~|\/)[^\s]*)/.exec(topic)?.[1] ?? null
  const model = /\bmodel[:=]\s*([^\s,;]+)/i.exec(topic)?.[1] ?? null
  const agent = /\bagent[:=]\s*([^\s,;]+)/i.exec(topic)?.[1] ?? null
  const category = channel.parent_id ? state.channels.find((c) => c.id === channel.parent_id)?.name : null
  return { folder, model, agent, machine: category ?? null }
}

function ChannelOverview({ state, channel }: { state: HubState; channel: Channel }) {
  const thread = THREAD_TYPES.has(channel.type)
  const category = channel.type === 4
  const sessions = useStore((d) => d.sessions)
  const feedback = useFeedback()
  const apply = (c: Channel) => store.apply(thread ? 'THREAD_UPDATE' : 'CHANNEL_UPDATE', c)
  const categories = state.channels.filter((c) => c.type === 4 && c.guild_id === channel.guild_id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const ws = workspace(state, channel)
  const session = sessions[channel.id]
  const editable = can(thread ? P.MANAGE_THREADS : P.MANAGE_CHANNELS, channel)
  const facts = thread
    ? [
        ['Project', session?.project],
        ['Machine', session?.machine],
        ['State', session?.state],
      ]
    : category
      ? []
      : [
          ['Project folder', ws.folder],
          ['Machine', ws.machine],
          ['Model', ws.model],
          ['Agent', ws.agent],
          ['Sessions', String(state.threads.filter((t) => t.parent_id === channel.id).length)],
        ]
  const shown = facts.filter((f): f is [string, string] => Boolean(f[1]))
  return (
    <Page title="Overview">
      <Group note={editable ? undefined : `You need ${thread ? 'Manage threads' : 'Manage channels'} to change these.`}>
        <TextSetting label={thread ? 'Thread name' : category ? 'Category name' : 'Channel name'} note={thread || category ? undefined : 'Lower case with dashes: “My Project” becomes my-project.'} value={channel.name ?? ''} max={100} disabled={!editable} onSave={(v) => api.patchChannel(channel.id, { name: v }).then(apply)} />
        {!thread && !category && (
          <TextSetting label="Topic" note="Shown in the channel header. For a project channel, its folder goes here." value={channel.topic ?? ''} max={1024} multiline allowEmpty disabled={!editable} placeholder="What this channel is for" onSave={(v) => api.patchChannel(channel.id, { topic: v || null }).then(apply)} />
        )}
        {!thread && !category && (
          <Item label="Category">
            <select
              className="settings-input settings-select"
              aria-label="Category"
              disabled={!editable}
              value={channel.parent_id ?? ''}
              onChange={(e) => void feedback.run(() => api.patchChannel(channel.id, { parent_id: e.target.value || null }).then(apply))}
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Item>
        )}
        <Feedback text={feedback.text} />
      </Group>
      {shown.length > 0 && (
        <Group title="Workspace" note={thread ? 'The agent session in this thread, from Kimaki.' : 'Read from the topic and the category.'}>
          <dl className="settings-facts">
            {shown.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </Group>
      )}
    </Page>
  )
}

function ChannelNotifications({ state, channel }: { state: HubState; channel: Channel }) {
  const n = state.notifications
  const own = n?.settings[channel.id]
  const now = effective(state, channel)
  const feedback = useFeedback()
  const parentLevel = effective({ ...state, notifications: n ? { ...n, settings: { ...n.settings, [channel.id]: { level: null, muted_until: null } } } : n }, channel).level
  type Choice = NotifyLevel | 'inherit'
  const options: Array<{ id: Choice; label: string; note?: string }> = [{ id: 'inherit', label: 'Use the default', note: `${LEVEL_TEXT[parentLevel]}, from the ${channel.parent_id ? 'parent' : 'server'}.` }, ...LEVELS]
  return (
    <Page title="Notifications">
      <Group title="Notify me about">
        <Radios<Choice> name="channel-level" label="Notify me about" value={own?.level ?? 'inherit'} options={options} disabled={!n} onChange={(id) => void feedback.run(() => store.setNotification(channel.id, { level: id === 'inherit' ? null : id }))} />
        <Feedback text={feedback.text} />
      </Group>
      <Group title="Mute" note={now.mutedUntil && !(own?.muted_until && own.muted_until > Date.now()) ? 'Muted through its parent or the server.' : 'A muted channel sends no notifications.'}>
        <MuteControl scopeId={channel.id} muted={mutedText(own?.muted_until ?? null)} label={`Mute ${channel.name}`} />
      </Group>
    </Page>
  )
}

function ChannelOutput({ channel }: { channel: Channel }) {
  const output = useStore(() => store.isOutput(channel))
  const locked = Boolean(channel.thread_metadata?.locked)
  return (
    <Page title="Output view">
      <Group note={`How this ${THREAD_TYPES.has(channel.type) ? 'thread' : 'channel'} reads on every device. Output feed suits bots that only report: no composer, compact rows.${locked ? ' Locked threads start as a feed.' : ''}`}>
        <Radios
          name="output"
          label="Output view"
          value={output ? 'feed' : 'chat'}
          onChange={(v) => void store.setOutput(channel, v === 'feed')}
          options={[
            { id: 'chat', label: 'Conversation', note: 'Messages with a composer, like any channel.' },
            { id: 'feed', label: 'Output feed', note: 'A read-only stream of what bots post.' },
          ]}
        />
      </Group>
    </Page>
  )
}

function ArchivePage({ channel }: { channel: Channel }) {
  const archived = Boolean(channel.thread_metadata?.archived)
  const feedback = useFeedback()
  return (
    <Page title="Archive">
      <Group title="This thread" note="Archived threads leave the channel list and come back when someone posts.">
        <Item label={archived ? 'Archived' : 'Active'}>
          <button className="button" onClick={() => void feedback.run(() => api.patchThread(channel.id, { archived: !archived }).then((c) => store.apply('THREAD_UPDATE', c)))}>
            {archived ? 'Unarchive' : 'Archive now'}
          </button>
        </Item>
        <Feedback text={feedback.text} />
      </Group>
      {/* TODO(hub): auto-archive after inactivity (Discord's auto_archive_duration). */}
      <Group title="Archive after inactivity">
        <Radios
          name="archive-after"
          label="Archive after inactivity"
          value="1440"
          disabled
          options={[
            { id: '60', label: '1 hour' },
            { id: '1440', label: '24 hours' },
            { id: '4320', label: '3 days' },
            { id: '10080', label: '1 week' },
          ]}
        />
        <Pending />
      </Group>
    </Page>
  )
}

function DeletePage({ state, channel }: { state: HubState; channel: Channel }) {
  const [typed, setTyped] = useState('')
  const feedback = useFeedback()
  const thread = THREAD_TYPES.has(channel.type)
  const name = channel.name ?? ''
  const threads = state.threads.filter((t) => t.parent_id === channel.id)
  const kind = thread ? 'thread' : channel.type === 4 ? 'category' : 'channel'
  const remove = () =>
    void feedback.run(async () => {
      await api.deleteChannel(channel.id)
      for (const t of threads) store.apply('THREAD_DELETE', { id: t.id })
      store.apply('CHANNEL_DELETE', { id: channel.id })
      if (location.hash === `#/c/${channel.id}` || threads.some((t) => location.hash === `#/c/${t.id}`)) location.hash = '#/overview'
    })
  return (
    <Page title={`Delete ${kind}`}>
      <Group>
        <div className="settings-danger">
          <Icon name="warn" size={20} />
          <p>
            {kind === 'category'
              ? `Deleting ${name} keeps its channels; they move out of the category.`
              : `Deleting ${thread ? plain(name) : `#${name}`} removes it and all its messages${threads.length ? `, and its ${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}` : ''}, for everyone and every bot. This can’t be undone.`}
          </p>
        </div>
        <label className="settings-field">
          <span className="settings-label">Type the {kind} name to confirm</span>
          <input className="settings-input" value={typed} placeholder={name} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && typed === name && remove()} />
        </label>
        <Feedback text={feedback.text} />
        <div className="settings-actions">
          <button className="button danger-fill" disabled={typed !== name} onClick={remove}>
            Delete {kind}
          </button>
        </div>
      </Group>
    </Page>
  )
}

export function ChannelSettings({ channelId, initial, onClose }: { channelId: string; initial?: string; onClose: () => void }) {
  const state = useStore((d) => d.state)
  const channel = useStore(() => store.channel(channelId))
  const phone = usePhone()
  const [picked, setPicked] = useState<string | null>(() => initial ?? (window.matchMedia(PHONE).matches ? null : 'overview'))
  const closing = useRef(false)
  // Deleted here or elsewhere: nothing left to edit.
  useEffect(() => {
    if (!channel && !closing.current) {
      closing.current = true
      if (history.state?.settings) history.back()
      else onClose()
    }
  }, [channel, onClose])
  if (!state || !channel) return null
  const thread = THREAD_TYPES.has(channel.type)
  const category = channel.type === 4
  const section = picked ?? (phone ? null : 'overview')
  const name = thread ? plain(channel.name ?? '') || 'untitled' : category ? (channel.name ?? '') : `#${channel.name}`
  const items: NavItem[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'notifications', label: 'Notifications' },
    ...(category ? [] : [{ id: 'output', label: 'Output view' }]),
    // Overrides are for people who can change them (Discord shows the page to them only).
    ...(can(P.MANAGE_ROLES, channel) ? [{ id: 'permissions', label: 'Permissions' }] : []),
    ...(thread ? [{ id: 'archive', label: 'Archive' }] : []),
  ]
  const manage = can(thread ? P.MANAGE_THREADS : P.MANAGE_CHANNELS, channel)
  const groups: NavGroup[] = [{ heading: name, items }, ...(manage ? [{ items: [{ id: 'delete', label: `Delete ${thread ? 'thread' : category ? 'category' : 'channel'}`, red: true }] }] : [])]
  const page =
    section === 'overview' ? <ChannelOverview state={state} channel={channel} />
    : section === 'notifications' ? <ChannelNotifications state={state} channel={channel} />
    : section === 'output' ? <ChannelOutput channel={channel} />
    : section === 'permissions' && can(P.MANAGE_ROLES, channel) ? <ChannelPermissionsPage state={state} channel={channel} />
    : section === 'archive' ? <ArchivePage channel={channel} />
    : section === 'delete' ? <DeletePage state={state} channel={channel} />
    : null
  return (
    <Shell label="Channel settings" groups={groups} section={section} onSection={setPicked} title={name} onClose={onClose}>
      {page}
    </Shell>
  )
}

// Mounted once by the app: opens either layer through sessionActions.
export function SettingsHost() {
  const [open, setOpen] = useState<{ kind: 'user'; section?: string; n: number } | { kind: 'channel'; id: string; section?: string; n: number } | null>(null)
  useEffect(() => {
    sessionActions.settings = (section) => setOpen({ kind: 'user', section, n: Date.now() })
    sessionActions.channelSettings = (id) => setOpen({ kind: 'channel', id, n: Date.now() })
    return () => {
      delete sessionActions.settings
      delete sessionActions.channelSettings
    }
  }, [])
  if (!open) return null
  const close = () => setOpen(null)
  return open.kind === 'user' ? <Settings key={open.n} initial={open.section} onClose={close} /> : <ChannelSettings key={open.n} channelId={open.id} onClose={close} />
}
