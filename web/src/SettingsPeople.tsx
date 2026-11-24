// People on a hub, like Discord's server settings: roles and their permissions,
// members with their roles, invites, the server-wide permissions of @everyone,
// and one channel's permission overrides. The hub enforces every rule (only roles
// below your highest, never a permission you lack); the UI disables what would
// be refused and shows the hub's reason when something still is.

import { useState } from 'react'
import { api, type Channel, type Guild, type GuildMember, type HubState, type Overwrite, type Role, type User } from './api.ts'
import { Avatar } from './Avatar.tsx'
import { Icon } from './icons.tsx'
import { bits, can, P, PERMISSION_GROUPS } from './perms.ts'
import { sessionActions } from './Sheet.tsx'
import { store, THREAD_TYPES } from './store.ts'
import { Confirm, currentGuild, Feedback, Group, hex, Item, Page, Switch, TextSetting, useFeedback } from './SettingsKit.tsx'

const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const nameOf = (u: User | undefined) => (u ? (u.global_name ?? u.username) : 'Someone')

// The open server, its roles and members, and where the viewer stands in it.
export function useGuild(state: HubState) {
  const guild: Guild = currentGuild(state)
  const roles = state.roles?.[guild.id] ?? []
  const members = state.members?.[guild.id] ?? []
  const owner = guild.owner_id ? guild.owner_id === state.me.id : state.hub_owner !== false
  const mine = members.find((m) => m.user_id === state.me.id)?.roles ?? []
  const top = owner ? Infinity : Math.max(0, ...roles.filter((r) => mine.includes(r.id)).map((r) => r.position))
  const perms = owner || guild.permissions === undefined ? ~0n : bits(guild.permissions)
  const admin = owner || (perms & P.ADMINISTRATOR) !== 0n
  return {
    guild,
    roles,
    members,
    owner,
    everyone: roles.find((r) => r.id === guild.id),
    // Roles the viewer may edit, assign or remove: below their highest.
    manageable: (role: Role) => role.id !== guild.id && (owner || role.position < top),
    // Bits the viewer may hand out.
    grantable: (bit: bigint) => admin || (perms & bit) === bit,
    canRoles: can(P.MANAGE_ROLES, null, guild.id),
    canServer: can(P.MANAGE_GUILD, null, guild.id),
  }
}
type GuildCtx = ReturnType<typeof useGuild>

const roleColor = (role: Role | undefined) => (role?.color ? hex(role.color) : undefined)

// The colour of a member's name: their highest coloured role, else their own.
function memberColor(ctx: GuildCtx, member: GuildMember | undefined, user: User | undefined) {
  const role = ctx.roles.find((r) => r.color && member?.roles.includes(r.id))
  return roleColor(role) ?? (user?.color != null ? hex(user.color) : undefined)
}

function CodeCard({ code, expires, note }: { code: string; expires: number; note: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="settings-code" role="status">
      <div className="settings-code-row">
        <code aria-label="Pairing code">{code}</code>
        <button
          className="button"
          onClick={() =>
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          <Icon name="copy" size={16} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="settings-item-note">Expires {fmtTime(expires)}. {note}</div>
    </div>
  )
}

// --- roles

// One toggle per permission, grouped like Discord's role editor.
function PermissionSwitches({ value, editable, grantable, onChange }: { value: bigint; editable: boolean; grantable: (bit: bigint) => boolean; onChange: (next: bigint) => void }) {
  return (
    <>
      {PERMISSION_GROUPS.map((group) => (
        <Group key={group.title} title={`${group.title} permissions`}>
          {group.items.map((p) => {
            const on = (value & p.bit) !== 0n
            const locked = !editable || (!on && !grantable(p.bit))
            return (
              <Item key={p.label} label={p.label} note={!editable || on || grantable(p.bit) ? p.note : `${p.note} You don’t have this permission, so you can’t grant it.`}>
                <Switch label={p.label} checked={on} disabled={locked} onChange={(next) => onChange(next ? value | p.bit : value & ~p.bit)} />
              </Item>
            )
          })}
        </Group>
      ))}
    </>
  )
}

function RoleEditor({ state, ctx, role, onBack }: { state: HubState; ctx: GuildCtx; role: Role; onBack: () => void }) {
  const everyone = role.id === ctx.guild.id
  const editable = ctx.canRoles && (everyone || ctx.manageable(role))
  const feedback = useFeedback()
  const [color, setColor] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const apply = (r: Role) => store.apply('GUILD_ROLE_UPDATE', { guild_id: ctx.guild.id, role: r })
  const patch = (body: Parameters<typeof api.patchRole>[2], done?: string) => void feedback.run(() => api.patchRole(ctx.guild.id, role.id, body).then(apply), done)
  const holders = ctx.members.filter((m) => m.roles.includes(role.id))
  const others = ctx.members.filter((m) => !m.roles.includes(role.id))
  const user = (id: string) => state.users.find((u) => u.id === id)
  const setHolder = (m: GuildMember, on: boolean) =>
    void feedback.run(async () => {
      const r = await api.setMemberRoles(ctx.guild.id, m.user_id, on ? [...m.roles, role.id] : m.roles.filter((x) => x !== role.id))
      store.apply('GUILD_MEMBER_UPDATE', { guild_id: ctx.guild.id, user: user(m.user_id), roles: r.roles })
    })
  const current = role.color ? hex(role.color) : null
  return (
    <>
      <button className="settings-back" onClick={onBack}>
        <Icon name="back" size={16} /> Roles
      </button>
      <Page title={everyone ? '@everyone' : role.name}>
        {!editable && <p className="settings-note">{ctx.canRoles ? 'This role is at or above your highest role, so you can only look.' : 'You need Manage roles to change roles.'}</p>}
        <Feedback text={feedback.text} />
        {!everyone && (
          <Group title="Display">
            <TextSetting label="Role name" value={role.name} max={100} disabled={!editable} onSave={(v) => api.patchRole(ctx.guild.id, role.id, { name: v }).then(apply)} />
            <Item label="Role colour" note="Members show in the colour of their highest coloured role.">
              <div className="settings-actions">
                <input className="settings-color" type="color" disabled={!editable} value={color ?? current ?? '#a3a3ae'} aria-label="Role colour" onChange={(e) => setColor(e.target.value)} />
                {color !== null && color !== current && (
                  <button className="button primary" onClick={() => (patch({ color: parseInt(color.slice(1), 16) }), setColor(null))}>
                    Save colour
                  </button>
                )}
                {current && editable && (
                  <button className="button" onClick={() => (patch({ color: 0 }), setColor(null))}>
                    No colour
                  </button>
                )}
              </div>
            </Item>
            <Item label="Show members separately" note="List people with this role in their own group in the member list.">
              <Switch label="Show members separately" checked={role.hoist} disabled={!editable} onChange={(v) => patch({ hoist: v })} />
            </Item>
            <Item label="Allow anyone to @mention this role" note="Everyone with the role is notified.">
              <Switch label="Allow anyone to @mention this role" checked={role.mentionable} disabled={!editable} onChange={(v) => patch({ mentionable: v })} />
            </Item>
          </Group>
        )}
        <PermissionSwitches value={bits(role.permissions)} editable={editable} grantable={ctx.grantable} onChange={(next) => patch({ permissions: String(next) })} />
        {!everyone && (
          <Group title={`Members · ${holders.length}`}>
            {holders.length === 0 && <p className="settings-empty">Nobody has this role yet.</p>}
            <div className="settings-list">
              {holders.map((m) => (
                <div key={m.user_id} className="settings-list-row">
                  <Avatar id={m.user_id} name={nameOf(user(m.user_id))} size="panel" version={user(m.user_id)?.avatar} />
                  <div className="settings-item-text">
                    <div className="settings-label">{nameOf(user(m.user_id))}</div>
                  </div>
                  {editable && (
                    <button className="button" onClick={() => setHolder(m, false)}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            {editable && others.length > 0 && (
              <select className="settings-input settings-select settings-add" aria-label="Add a member to this role" value="" onChange={(e) => e.target.value && setHolder(others.find((m) => m.user_id === e.target.value)!, true)}>
                <option value="">Add a member…</option>
                {others.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {nameOf(user(m.user_id))}
                  </option>
                ))}
              </select>
            )}
          </Group>
        )}
        {!everyone && editable && (
          <Group title="Delete role" note="Members lose what this role gave them. Channel overrides for it go too.">
            {deleting ? (
              <Confirm text={`Delete ${role.name}? This can’t be undone.`} action="Delete role" onCancel={() => setDeleting(false)} onConfirm={() => void feedback.run(async () => {
                await api.deleteRole(ctx.guild.id, role.id)
                store.apply('GUILD_ROLE_DELETE', { guild_id: ctx.guild.id, role_id: role.id })
                onBack()
              })} />
            ) : (
              <button className="button danger" onClick={() => setDeleting(true)}>
                Delete role
              </button>
            )}
          </Group>
        )}
      </Page>
    </>
  )
}

export function RolesPage({ state }: { state: HubState }) {
  const ctx = useGuild(state)
  const [editing, setEditing] = useState<string | null>(null)
  const feedback = useFeedback()
  const role = editing ? ctx.roles.find((r) => r.id === editing) : undefined
  if (role) return <RoleEditor key={role.id} state={state} ctx={ctx} role={role} onBack={() => setEditing(null)} />
  const list = ctx.roles.filter((r) => r.id !== ctx.guild.id).sort((a, b) => b.position - a.position)
  const count = (r: Role) => ctx.members.filter((m) => m.roles.includes(r.id)).length
  const create = () =>
    void feedback.run(async () => {
      const r = await api.createRole(ctx.guild.id, { name: 'new role' })
      store.apply('GUILD_ROLE_CREATE', { guild_id: ctx.guild.id, role: r })
      setEditing(r.id)
    })
  // Swap with the neighbour: both must be below the viewer's highest role.
  const swap = (a: Role, b: Role) =>
    void feedback.run(async () => {
      const first = await api.patchRole(ctx.guild.id, a.id, { position: b.position })
      const second = await api.patchRole(ctx.guild.id, b.id, { position: a.position })
      for (const r of [first, second]) store.apply('GUILD_ROLE_UPDATE', { guild_id: ctx.guild.id, role: r })
    })
  const row = (r: Role, i: number) => (
    <div key={r.id} className="settings-channel">
      <i className="settings-role-dot" style={{ background: roleColor(r) ?? 'var(--text-faint)' }} aria-hidden="true" />
      <div className="settings-item-text">
        <div className="settings-label">{r.name}</div>
        <div className="settings-item-note">
          {count(r)} {count(r) === 1 ? 'member' : 'members'}
          {(bits(r.permissions) & P.ADMINISTRATOR) !== 0n ? ' · Administrator' : ''}
        </div>
      </div>
      <div className="settings-row-tools">
        {ctx.canRoles && (
          <>
            <button className="icon-button" disabled={i === 0 || !ctx.manageable(r) || !ctx.manageable(list[i - 1]!)} onClick={() => swap(r, list[i - 1]!)} aria-label={`Move ${r.name} up`} title="Move up">
              <Icon name="down" size={16} className="settings-up" />
            </button>
            <button className="icon-button" disabled={i === list.length - 1 || !ctx.manageable(r) || !ctx.manageable(list[i + 1]!)} onClick={() => swap(r, list[i + 1]!)} aria-label={`Move ${r.name} down`} title="Move down">
              <Icon name="down" size={16} />
            </button>
          </>
        )}
        <button className="icon-button" onClick={() => setEditing(r.id)} aria-label={`Edit ${r.name}`} title="Edit">
          <Icon name="gear" size={16} />
        </button>
      </div>
    </div>
  )
  return (
    <Page title="Roles">
      <Group note="Roles group people and bots and decide what they can do. Higher roles come first; you can manage the ones below your own highest role.">
        <div className="settings-actions">
          <button className="button primary" disabled={!ctx.canRoles} onClick={create}>
            Create role
          </button>
        </div>
        <Feedback text={feedback.text} />
      </Group>
      <section className="settings-channel-group" aria-label="Roles">
        {list.map(row)}
        {ctx.everyone && (
          <div className="settings-channel">
            <Icon name="members" size={18} />
            <div className="settings-item-text">
              <div className="settings-label">@everyone</div>
              <div className="settings-item-note">The default for everyone on the server</div>
            </div>
            <div className="settings-row-tools">
              <button className="icon-button" onClick={() => setEditing(ctx.guild.id)} aria-label="Edit @everyone" title="Edit">
                <Icon name="gear" size={16} />
              </button>
            </div>
          </div>
        )}
      </section>
    </Page>
  )
}

// --- members

function InvitePerson({ ctx, state }: { ctx: GuildCtx; state: HubState }) {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [display, setDisplay] = useState('')
  const [result, setResult] = useState<{ name: string; code: string; expires: number } | null>(null)
  const feedback = useFeedback()
  const members = new Set(ctx.members.map((m) => m.user_id))
  const candidates = state.users.filter((u) => !u.bot && !members.has(u.id))
  const invite = () =>
    void feedback.run(async () => {
      const r = await api.invite(ctx.guild.id, { username: username.trim(), ...(display.trim() && { global_name: display.trim() }) })
      if (r.code && r.expires_at) setResult({ name: nameOf(r.user), code: r.code, expires: r.expires_at })
      setUsername('')
      setDisplay('')
      setOpen(false)
    })
  return (
    <Group title="Invite a person" note="A new account on this hub, with a pairing code for their first device. They join this server; give them roles below.">
      {result && <CodeCard code={result.code} expires={result.expires} note={`${result.name} enters it in Vocorum under New device. If they connect over Tailscale, the hub owner must first register their Tailscale login on the hub machine with the vocorum CLI.`} />}
      {open ? (
        <form
          className="settings-create"
          aria-label="Invite a person"
          onSubmit={(e) => {
            e.preventDefault()
            if (username.trim()) invite()
          }}
        >
          <div className="settings-two">
            <label className="settings-field">
              <span className="settings-label">Username</span>
              <input className="settings-input" value={username} autoFocus maxLength={32} placeholder="sam" autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
              <span className="settings-item-note">Letters, digits, dots and underscores.</span>
            </label>
            <label className="settings-field">
              <span className="settings-label">Display name</span>
              <input className="settings-input" value={display} maxLength={32} placeholder="Optional" onChange={(e) => setDisplay(e.target.value)} />
            </label>
          </div>
          <Feedback text={feedback.text} />
          <div className="settings-actions">
            <button type="button" className="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={username.trim().length < 2}>
              Create invite
            </button>
          </div>
        </form>
      ) : (
        <div className="settings-actions">
          <button className="button primary" onClick={() => (setOpen(true), setResult(null))}>
            Invite a person
          </button>
          {candidates.length > 0 && (
            <select
              className="settings-input settings-select"
              aria-label="Add someone already on the hub"
              value=""
              onChange={(e) =>
                e.target.value &&
                void feedback.run(async () => {
                  await api.invite(ctx.guild.id, { user_id: e.target.value })
                  await store.loadState()
                }, 'Added to the server.')
              }
            >
              <option value="">Add someone already on the hub…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {nameOf(u)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {!open && <Feedback text={feedback.text} />}
    </Group>
  )
}

function MemberRow({ state, ctx, member }: { state: HubState; ctx: GuildCtx; member: GuildMember }) {
  const user = state.users.find((u) => u.id === member.user_id)
  const feedback = useFeedback()
  const [removing, setRemoving] = useState(false)
  const me = member.user_id === state.me.id
  const isOwner = ctx.guild.owner_id === member.user_id
  const status = state.presence?.[member.user_id]?.status ?? (me ? 'online' : 'offline')
  const held = ctx.roles.filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position)
  const addable = ctx.roles.filter((r) => ctx.manageable(r) && !member.roles.includes(r.id) && (ctx.grantable(bits(r.permissions)) || bits(r.permissions) === 0n))
  const setRoles = (roles: string[]) =>
    void feedback.run(async () => {
      const r = await api.setMemberRoles(ctx.guild.id, member.user_id, roles)
      store.apply('GUILD_MEMBER_UPDATE', { guild_id: ctx.guild.id, user, roles: r.roles })
    })
  const remove = () =>
    void feedback.run(async () => {
      await api.removeMember(ctx.guild.id, member.user_id)
      if (me) return location.reload()
      store.apply('GUILD_MEMBER_REMOVE', { guild_id: ctx.guild.id, user })
    })
  const canRemove = !isOwner && (me || ctx.canServer)
  return (
    <div className="settings-member">
      <div className="settings-member-main">
        <span className="member-avatar">
          <Avatar id={member.user_id} name={nameOf(user)} size="panel" version={user?.avatar} />
          <i className={`presence ${status}`} aria-label={status} />
        </span>
        <div className="settings-item-text">
          <div className="settings-label" style={{ color: memberColor(ctx, member, user) }}>
            {member.nick ?? nameOf(user)}
            {isOwner && <span className="settings-tag">Owner</span>}
            {user?.bot && <span className="settings-tag">Bot</span>}
            {me && <span className="settings-tag">You</span>}
          </div>
          <div className="settings-item-note">{user?.username}</div>
        </div>
        {canRemove && !removing && (
          <button className="button danger" onClick={() => setRemoving(true)}>
            {me ? 'Leave' : 'Remove'}
          </button>
        )}
      </div>
      {removing && (
        <Confirm
          text={me ? `Leave ${ctx.guild.name}? You will need an invite to come back.` : `Remove ${nameOf(user)} from ${ctx.guild.name}? They lose access to its channels.`}
          action={me ? 'Leave' : 'Remove'}
          onCancel={() => setRemoving(false)}
          onConfirm={remove}
        />
      )}
      <div className="settings-chips" aria-label={`Roles of ${nameOf(user)}`}>
        {held.map((r) => (
          <span key={r.id} className="settings-chip">
            <i className="settings-role-dot" style={{ background: roleColor(r) ?? 'var(--text-faint)' }} aria-hidden="true" />
            {r.name}
            {ctx.canRoles && ctx.manageable(r) && (
              <button onClick={() => setRoles(member.roles.filter((x) => x !== r.id))} aria-label={`Remove ${r.name} from ${nameOf(user)}`} title="Remove role">
                <Icon name="close" size={12} />
              </button>
            )}
          </span>
        ))}
        {ctx.canRoles && addable.length > 0 && (
          <select className="settings-chip-add" aria-label={`Add a role to ${nameOf(user)}`} value="" onChange={(e) => e.target.value && setRoles([...member.roles, e.target.value])}>
            <option value="">+ Role</option>
            {addable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <Feedback text={feedback.text} />
    </div>
  )
}

export function MembersPage({ state }: { state: HubState }) {
  const ctx = useGuild(state)
  const user = (id: string) => state.users.find((u) => u.id === id)
  const sorted = [...ctx.members].sort((a, b) => Number(b.user_id === ctx.guild.owner_id) - Number(a.user_id === ctx.guild.owner_id) || nameOf(user(a.user_id)).localeCompare(nameOf(user(b.user_id))))
  return (
    <Page title="Members">
      {ctx.canServer && <InvitePerson ctx={ctx} state={state} />}
      <Group title={`Members · ${sorted.length}`}>
        <div className="settings-list">
          {sorted.map((m) => (
            <MemberRow key={m.user_id} state={state} ctx={ctx} member={m} />
          ))}
        </div>
      </Group>
    </Page>
  )
}

// --- server-wide permissions: what @everyone can do

export function ServerPermissionsPage({ state }: { state: HubState }) {
  const ctx = useGuild(state)
  const feedback = useFeedback()
  const everyone = ctx.everyone
  const extra = ctx.roles.filter((r) => r.id !== ctx.guild.id && bits(r.permissions) !== 0n)
  return (
    <Page title="Permissions">
      <Group note={`What everyone in ${ctx.guild.name} can do. Roles add to this, and channels can override both.`}>
        <Feedback text={feedback.text} />
      </Group>
      {everyone && (
        <PermissionSwitches
          value={bits(everyone.permissions)}
          editable={ctx.canRoles}
          grantable={ctx.grantable}
          onChange={(next) => void feedback.run(() => api.patchRole(ctx.guild.id, everyone.id, { permissions: String(next) }).then((r) => store.apply('GUILD_ROLE_UPDATE', { guild_id: ctx.guild.id, role: r })))}
        />
      )}
      {extra.length > 0 && (
        <Group title="Roles that add permissions" note="Edit them under Roles.">
          <div className="settings-list">
            {extra.map((r) => {
              const names = PERMISSION_GROUPS.flatMap((g) => g.items).filter((p) => (bits(r.permissions) & p.bit) !== 0n && (bits(everyone?.permissions) & p.bit) === 0n)
              return (
                <div key={r.id} className="settings-list-row">
                  <i className="settings-role-dot" style={{ background: roleColor(r) ?? 'var(--text-faint)' }} aria-hidden="true" />
                  <div className="settings-item-text">
                    <div className="settings-label">{r.name}</div>
                    <div className="settings-item-note">{(bits(r.permissions) & P.ADMINISTRATOR) !== 0n ? 'Administrator: every permission' : names.map((p) => p.label).join(', ') || 'Nothing beyond @everyone'}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </Group>
      )}
    </Page>
  )
}

// --- one channel's overrides (Discord's channel Permissions)

type Tri = 'allow' | 'neutral' | 'deny'
const TRI: Array<{ id: Tri; label: string; path: string }> = [
  { id: 'deny', label: 'Deny', path: 'M7 7l10 10M17 7 7 17' },
  { id: 'neutral', label: 'Inherit', path: 'M16 8 8 16' },
  { id: 'allow', label: 'Allow', path: 'm6.5 12.5 3.5 3.5 7.5-8' },
]

function TriState({ label, value, disabled, onChange }: { label: string; value: Tri; disabled: boolean; onChange: (v: Tri) => void }) {
  return (
    <div className="settings-tri" role="radiogroup" aria-label={label}>
      {TRI.map((t) => (
        <button key={t.id} role="radio" aria-checked={value === t.id} aria-label={`${t.label} ${label}`} title={t.label} className={`settings-tri-${t.id}${value === t.id ? ' on' : ''}`} disabled={disabled} onClick={() => value !== t.id && onChange(t.id)}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={t.path} />
          </svg>
        </button>
      ))}
    </div>
  )
}

export function ChannelPermissionsPage({ state, channel }: { state: HubState; channel: Channel }) {
  const guildId = channel.guild_id ?? state.guild.id
  const roles = state.roles?.[guildId] ?? []
  const members = state.members?.[guildId] ?? []
  const overwrites = channel.permission_overwrites ?? []
  const editable = can(P.MANAGE_ROLES, channel)
  const feedback = useFeedback()
  const [selected, setSelected] = useState(guildId)
  if (THREAD_TYPES.has(channel.type)) {
    const parent = store.channel(channel.parent_id ?? '')
    return (
      <Page title="Permissions">
        <Group note={`Threads follow the permissions of ${parent ? `#${parent.name}` : 'their channel'}.`}>
          {parent && (
            <button className="button" onClick={() => sessionActions.channelSettings?.(parent.id)}>
              Open #{parent.name} permissions
            </button>
          )}
        </Group>
      </Page>
    )
  }
  const user = (id: string) => state.users.find((u) => u.id === id)
  const label = (o: { id: string; type: 0 | 1 }) => (o.type === 0 ? (o.id === guildId ? '@everyone' : (roles.find((r) => r.id === o.id)?.name ?? 'Deleted role')) : nameOf(user(o.id)))
  const targets: Array<{ id: string; type: 0 | 1 }> = [{ id: guildId, type: 0 }, ...overwrites.filter((o) => o.id !== guildId).map((o) => ({ id: o.id, type: o.type }))]
  const target = targets.find((t) => t.id === selected) ?? targets[0]!
  const ow = overwrites.find((o) => o.id === target.id)
  const allow = bits(ow?.allow)
  const deny = bits(ow?.deny)
  const applyResult = (r: { channel_id: string; permission_overwrites: Overwrite[] }) => store.apply('CHANNEL_PERMISSIONS_UPDATE', r)
  const put = (t: { id: string; type: 0 | 1 }, a: bigint, d: bigint) => api.setOverwrite(channel.id, t.id, { type: t.type, allow: String(a), deny: String(d) }).then(applyResult)
  const set = (bit: bigint, v: Tri) => void feedback.run(() => put(target, v === 'allow' ? allow | bit : allow & ~bit, v === 'deny' ? deny | bit : deny & ~bit))
  const everyoneOw = overwrites.find((o) => o.id === guildId)
  const isPrivate = (bits(everyoneOw?.deny) & P.VIEW_CHANNEL) !== 0n
  // Private: you keep access first, then @everyone loses View channel.
  const setPrivate = (on: boolean) =>
    void feedback.run(async () => {
      const ea = bits(everyoneOw?.allow)
      const ed = bits(everyoneOw?.deny)
      if (on) {
        const mine = overwrites.find((o) => o.id === state.me.id)
        await put({ id: state.me.id, type: 1 }, bits(mine?.allow) | P.VIEW_CHANNEL, bits(mine?.deny) & ~P.VIEW_CHANNEL)
        await put({ id: guildId, type: 0 }, ea & ~P.VIEW_CHANNEL, ed | P.VIEW_CHANNEL)
      } else if (ea === 0n && (ed & ~P.VIEW_CHANNEL) === 0n) {
        await api.setOverwrite(channel.id, guildId, null).then(applyResult)
      } else {
        await put({ id: guildId, type: 0 }, ea, ed & ~P.VIEW_CHANNEL)
      }
    })
  const missingRoles = roles.filter((r) => r.id !== guildId && !targets.some((t) => t.id === r.id))
  const missingMembers = members.filter((m) => !targets.some((t) => t.id === m.user_id))
  const add = (value: string) => {
    const [type, id] = value.split(':') as ['0' | '1', string]
    void feedback.run(async () => {
      await put({ id, type: type === '0' ? 0 : 1 }, 0n, 0n)
      setSelected(id)
    })
  }
  const items = PERMISSION_GROUPS.map((g) => ({ ...g, items: g.items.filter((p) => p.channel) })).filter((g) => g.items.length)
  return (
    <Page title="Permissions">
      <Group>
        <Item label="Private channel" note={channel.type === 4 ? 'Only the roles and members you pick can see this category and channels that follow it.' : 'Only the roles and members you pick can see this channel.'}>
          <Switch label="Private channel" checked={isPrivate} disabled={!editable} onChange={setPrivate} />
        </Item>
        {!editable && <p className="settings-note">You need Manage roles in this channel to change its permissions.</p>}
        <Feedback text={feedback.text} />
      </Group>
      <Group title="Advanced permissions" note="Override what a role or member can do here. Inherit follows the server’s roles.">
        <div className="settings-overwrites">
          <div className="settings-targets" role="listbox" aria-label="Roles and members">
            <div className="settings-targets-head">Roles and members</div>
            {targets.map((t) => (
              <button key={t.id} role="option" aria-selected={t.id === target.id} className="settings-target" onClick={() => setSelected(t.id)}>
                {t.type === 0 ? <i className="settings-role-dot" style={{ background: roleColor(roles.find((r) => r.id === t.id)) ?? 'var(--text-faint)' }} aria-hidden="true" /> : <Avatar id={t.id} name={label(t)} size="inline" version={user(t.id)?.avatar} />}
                <span>{label(t)}</span>
              </button>
            ))}
            {editable && (missingRoles.length > 0 || missingMembers.length > 0) && (
              <select className="settings-input settings-target-add" aria-label="Add a role or member" value="" onChange={(e) => e.target.value && add(e.target.value)}>
                <option value="">Add a role or member…</option>
                {missingRoles.length > 0 && (
                  <optgroup label="Roles">
                    {missingRoles.map((r) => (
                      <option key={r.id} value={`0:${r.id}`}>
                        {r.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {missingMembers.length > 0 && (
                  <optgroup label="Members">
                    {missingMembers.map((m) => (
                      <option key={m.user_id} value={`1:${m.user_id}`}>
                        {nameOf(user(m.user_id))}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
          </div>
          <div className="settings-overwrite-bits">
            <div className="settings-overwrite-head">
              <span className="settings-heading">{label(target)}</span>
              {editable && target.id !== guildId && (
                <button className="button danger" onClick={() => void feedback.run(async () => {
                  await api.setOverwrite(channel.id, target.id, null).then(applyResult)
                  setSelected(guildId)
                })}>
                  Remove
                </button>
              )}
            </div>
            {items.map((g) => (
              <div key={g.title} className="settings-bit-group">
                <div className="settings-subheading">{g.title}</div>
                {g.items.map((p) => (
                  <Item key={p.label} label={p.label} note={p.note}>
                    <TriState label={p.label} value={(allow & p.bit) !== 0n ? 'allow' : (deny & p.bit) !== 0n ? 'deny' : 'neutral'} disabled={!editable} onChange={(v) => set(p.bit, v)} />
                  </Item>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Group>
    </Page>
  )
}

// --- this person's other devices

export function PairDevice() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [code, setCode] = useState<{ code: string; expires_at: number } | null>(null)
  const feedback = useFeedback()
  return (
    <Group title="Pair another device" note="A short-lived code that signs another of your devices in as you.">
      {code && <CodeCard code={code.code} expires={code.expires_at} note="On the new device, open Vocorum and enter it under New device." />}
      {open ? (
        <form
          className="settings-field-row"
          onSubmit={(e) => {
            e.preventDefault()
            void feedback.run(async () => {
              setCode(await api.pairDevice(name.trim() || 'device'))
              setOpen(false)
              setName('')
            })
          }}
        >
          <input className="settings-input" value={name} autoFocus maxLength={64} placeholder="Device name, like Laptop" aria-label="New device name" onChange={(e) => setName(e.target.value)} />
          <button type="button" className="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Get a code
          </button>
        </form>
      ) : (
        <div className="settings-actions">
          <button className="button primary" onClick={() => (setOpen(true), setCode(null))}>
            Pair another device
          </button>
        </div>
      )}
      <Feedback text={feedback.text} />
    </Group>
  )
}
