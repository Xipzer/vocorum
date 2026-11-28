// Ephemeral interaction replies are not channel messages. Keep their short-lived
// originals here, so history, search, unread counts and gateway replay never see them.
import { MessageFlags, MessageType, type APIMessage, type APIUser } from 'discord-api-types/v10'
import { generateSnowflake } from './snowflake.js'
import { interactionFields, type StoredInteraction } from './serializers.js'

type Body = { content?: string | null; embeds?: unknown[] | null; components?: unknown[] | null; flags?: number | null }
type Entry = { interaction: string; user: string; message: APIMessage; timer: NodeJS.Timeout }
export type PrivateEvent = (userId: string, message: APIMessage, removed: boolean) => void

export class PrivateReplies {
  private rows = new Map<string, Entry>()
  constructor(private readonly deliver?: PrivateEvent) {}

  create(meta: StoredInteraction, author: APIUser, channel: string, application: string, body: Body) {
    const id = generateSnowflake()
    const message = { id, channel_id: channel, application_id: application, webhook_id: application, author, type: MessageType.Default,
      content: body.content ?? '', embeds: body.embeds ?? [], components: body.components ?? [], flags: (body.flags ?? 0) | MessageFlags.Ephemeral,
      timestamp: new Date().toISOString(), edited_timestamp: null, attachments: [], mentions: [], mention_roles: [], mention_everyone: false, pinned: false, tts: false,
      ...interactionFields(meta),
    } as APIMessage
    const timer = setTimeout(() => this.remove(id), 15 * 60_000).unref()
    this.rows.set(id, { interaction: meta.id, user: meta.user.id, message, timer })
    this.deliver?.(meta.user.id, message, false)
    return message
  }
  list(user: string, channel: string) {
    return [...this.rows.values()].filter((r) => r.user === user && r.message.channel_id === channel).map((r) => r.message)
  }
  forUser(user: string, channel: string, id: string) {
    const r = this.rows.get(id)
    return r?.user === user && r.message.channel_id === channel ? r.message : undefined
  }
  forWebhook(interaction: { interactionId: string; messageId: string | null }, id: string | null, user?: string) {
    const r = id && this.rows.get(id)
    return r && (r.interaction === interaction.interactionId || (id === interaction.messageId && r.user === user)) ? r.message : undefined
  }
  edit(m: APIMessage, body: Body) {
    const r = this.rows.get(m.id)!
    r.message = { ...m, content: body.content ?? m.content, embeds: body.embeds ?? m.embeds, components: body.components ?? m.components,
      edited_timestamp: (m.flags ?? 0) & MessageFlags.Loading ? null : new Date().toISOString(), flags: ((body.flags ?? m.flags ?? 0) & ~MessageFlags.Loading) | MessageFlags.Ephemeral } as APIMessage
    this.deliver?.(r.user, r.message, false)
    return r.message
  }
  remove(id: string) {
    const r = this.rows.get(id)
    if (!r) return
    clearTimeout(r.timer)
    this.rows.delete(id)
    this.deliver?.(r.user, r.message, true)
  }
  clear() { for (const r of this.rows.values()) clearTimeout(r.timer); this.rows.clear() }
}
