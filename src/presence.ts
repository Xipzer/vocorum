// Who is online, per user, for the member list: people through their signed-in
// devices' event connections (and the channel each shows), bots through their
// machines' gateway connections. Each person decides whether others see their
// status (show_presence) and where they are (show_activity); others only ever
// see channels they can view themselves. PRESENCE_UPDATE goes out per recipient.

import type { Hub } from './hub.ts'

export type PresenceStatus = 'online' | 'idle' | 'offline'
export type UserPresence = {
  user_id: string
  status: PresenceStatus
  // People: each connected app window.
  devices?: Array<{ id: string; name: string; channel_id: string | null; visible: boolean }>
  // Bots: each machine that logs in as this bot user.
  machines?: Array<{ machine: string; online: boolean }>
}

export class Presence {
  private last = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private unobserve: (() => void) | null = null
  private bots: Array<{ machine: string; token: string }> = []

  constructor(private readonly hub: Hub) {}

  async start() {
    await this.reload()
    this.unobserve = this.hub.twin.observeGatewayConnections(() => this.changed())
  }

  stop() {
    this.unobserve?.()
    if (this.timer) clearTimeout(this.timer)
  }

  // Bot tokens change only through the CLI.
  async reload() {
    this.bots = (await this.hub.store.listBots()).filter((b) => !b.revokedAt).map((b) => ({ machine: b.machine, token: `${b.clientId}:${b.secretHash}` }))
    this.changed()
  }

  // Everyone's presence as they are, before privacy.
  private raw(): Map<string, UserPresence> {
    const { botUserId } = this.hub.options.config
    const out = new Map<string, UserPresence>()
    for (const c of this.hub.events.connections()) {
      const entry = out.get(c.userId) ?? { user_id: c.userId, status: 'offline' as PresenceStatus, devices: [] }
      entry.devices!.push({ id: c.deviceId, name: c.name, channel_id: c.channelId, visible: c.visible })
      out.set(c.userId, entry)
    }
    for (const entry of out.values()) entry.status = entry.devices!.some((d) => d.visible) ? 'online' : 'idle'
    const connected = this.hub.twin.connectedGatewayTokens()
    const machines = this.bots.map((b) => ({ machine: b.machine, online: connected.has(b.token) }))
    out.set(botUserId, { user_id: botUserId, status: machines.some((m) => m.online) ? 'online' : 'offline', machines })
    return out
  }

  // What `viewer` may see of `presence`.
  private async shape(presence: UserPresence, viewer: string, profiles: Record<string, { showPresence: boolean; showActivity: boolean }>): Promise<UserPresence> {
    if (presence.user_id === viewer || presence.machines) return presence
    const profile = profiles[presence.user_id]
    if (profile && !profile.showPresence) return { user_id: presence.user_id, status: 'offline' }
    if (profile && !profile.showActivity) return { user_id: presence.user_id, status: presence.status }
    const visible = await this.hub.access.visibleChannels(viewer)
    return { ...presence, devices: presence.devices?.map((d) => ({ ...d, channel_id: d.channel_id && visible.has(d.channel_id) ? d.channel_id : null })) }
  }

  // Presence of the people `viewer` shares a guild with, and the bot.
  async snapshotFor(viewer: string): Promise<Record<string, UserPresence>> {
    const peers = await this.hub.access.peers(viewer)
    const profiles = await this.hub.store.profiles()
    const out: Record<string, UserPresence> = {}
    for (const presence of this.raw().values()) {
      if (presence.user_id !== viewer && !peers.has(presence.user_id) && !presence.machines) continue
      out[presence.user_id] = await this.shape(presence, viewer, profiles)
    }
    for (const id of peers) out[id] ??= { user_id: id, status: 'offline' }
    return out
  }

  // After a privacy change: send this user's presence again.
  forget(userId: string) {
    this.last.delete(userId)
    this.changed()
  }

  // Coalesced: a reconnect storm sends one update per user.
  changed() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch((error) => console.error('[presence]', error))
    }, 100)
    this.timer.unref()
  }

  private async flush() {
    const profiles = await this.hub.store.profiles()
    const current = this.raw()
    const ids = new Set([...current.keys(), ...this.last.keys()])
    for (const id of ids) {
      const presence = current.get(id) ?? { user_id: id, status: 'offline' as PresenceStatus }
      const key = JSON.stringify(presence)
      if (this.last.get(id) === key) continue
      if (current.has(id)) this.last.set(id, key)
      else this.last.delete(id)
      const peers = presence.machines ? null : await this.hub.access.peers(id)
      const shapes = new Map<string, UserPresence>()
      for (const connection of this.hub.events.connections()) {
        if (!shapes.has(connection.userId)) shapes.set(connection.userId, await this.shape(presence, connection.userId, profiles))
      }
      this.hub.events.send('PRESENCE_UPDATE', presence, { shape: (viewer) => (peers && viewer !== id && !peers.has(viewer) ? null : (shapes.get(viewer) ?? null)) })
    }
  }

  // Devices of a user that are in front right now: they see new messages live.
  visibleDevices(userId: string): Set<string> {
    return new Set(this.hub.events.connections().filter((c) => c.visible && c.userId === userId).map((c) => c.deviceId))
  }
}
