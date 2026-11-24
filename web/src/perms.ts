// What the signed-in person may do, from the hub's computed permissions (Discord's
// bits as decimal strings on guilds, channels and threads). Hubs that send none
// are single-person hubs: everything is allowed.

import type { Channel } from './api.ts'
import { store } from './store.ts'

export const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_ROLES: 1n << 28n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  PIN_MESSAGES: 1n << 51n,
} as const
export type PermissionName = keyof typeof P

// The permissions the UI offers, grouped like Discord's role editor.
export const PERMISSION_GROUPS: Array<{ title: string; items: Array<{ bit: bigint; label: string; note: string; channel?: boolean }> }> = [
  {
    title: 'General',
    items: [
      { bit: P.VIEW_CHANNEL, label: 'View channels', note: 'See channels and read what is in them.', channel: true },
      { bit: P.MANAGE_CHANNELS, label: 'Manage channels', note: 'Create, edit and delete channels.', channel: true },
      { bit: P.MANAGE_ROLES, label: 'Manage roles', note: 'Create and edit roles below their own, and set channel permissions.', channel: true },
      { bit: P.MANAGE_GUILD, label: 'Manage server', note: 'Rename the server, change its icon, invite and remove people.' },
      { bit: P.CREATE_INSTANT_INVITE, label: 'Create invite', note: 'Invite people to the server.', channel: true },
    ],
  },
  {
    title: 'Text',
    items: [
      { bit: P.SEND_MESSAGES, label: 'Send messages', note: 'Post in channels.', channel: true },
      { bit: P.ADD_REACTIONS, label: 'Add reactions', note: 'React to messages with emoji.', channel: true },
      { bit: P.ATTACH_FILES, label: 'Attach files', note: 'Upload files and voice notes.', channel: true },
      { bit: P.READ_MESSAGE_HISTORY, label: 'Read message history', note: 'See messages sent before they opened the channel.', channel: true },
      { bit: P.MENTION_EVERYONE, label: 'Mention @everyone', note: 'Notify everyone in a channel at once.', channel: true },
      { bit: P.PIN_MESSAGES, label: 'Pin messages', note: 'Pin and unpin messages.', channel: true },
      { bit: P.MANAGE_MESSAGES, label: 'Manage messages', note: 'Delete and pin other people’s messages.', channel: true },
      { bit: P.USE_APPLICATION_COMMANDS, label: 'Use application commands', note: 'Run slash commands from bots.', channel: true },
    ],
  },
  {
    title: 'Threads',
    items: [
      { bit: P.CREATE_PUBLIC_THREADS, label: 'Create threads', note: 'Start threads from channels.', channel: true },
      { bit: P.SEND_MESSAGES_IN_THREADS, label: 'Send messages in threads', note: 'Post in threads, including agent sessions.', channel: true },
      { bit: P.MANAGE_THREADS, label: 'Manage threads', note: 'Rename, archive and delete any thread.', channel: true },
    ],
  },
  {
    title: 'Advanced',
    items: [{ bit: P.ADMINISTRATOR, label: 'Administrator', note: 'Every permission, and every channel whatever its overrides. Grant with care.' }],
  },
]

export const bits = (value: string | undefined | null) => (value ? BigInt(value) : 0n)

// The person's permissions in a guild, or in a channel (threads carry their channel's).
export function permissionsIn(channel?: Channel | string | null, guildId?: string): bigint | null {
  const state = store.data.state
  if (!state) return null
  const c = typeof channel === 'string' ? store.channel(channel) : channel
  if (c?.permissions != null) return bits(c.permissions)
  const gid = c?.guild_id ?? guildId ?? state.guild?.id
  const guild = state.guilds?.find((g) => g.id === gid)
  return guild?.permissions != null ? bits(guild.permissions) : null
}

// can(P.SEND_MESSAGES, channel): every bit asked for, or Administrator.
export function can(want: bigint, channel?: Channel | string | null, guildId?: string): boolean {
  const have = permissionsIn(channel, guildId)
  if (have === null) return true
  if (have & P.ADMINISTRATOR) return true
  return (have & want) === want
}

// Only the person who runs the hub sees services and machine health.
export function isHubOwner(): boolean {
  return store.data.state?.hub_owner !== false
}
