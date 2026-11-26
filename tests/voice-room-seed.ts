// A voice channel as a coding agent leaves it: the owner's spoken lines, the agent's
// steps, its answers and a result card in the channel's own chat, and the agent in the
// room with a status. Shared by the voice room browser test and its screenshots.

import { ActivityType, ChannelType, MessageFlags, type VoiceChannel } from 'discord.js'
import type { Hub } from '../src/hub.ts'
import type { startDemoBot } from './demo-bot.ts'

export const STEPS = ['-# ┣ grep _joinedAt_', '-# ┣ read _web/src/voice.ts_', '-# ┣ read _web/src/Voice.tsx_', '-# ┣ edit _web/src/voice.ts_', '-# ┣ shell _pnpm vitest run tests/voice.test.ts_']

export async function seedVoiceRoom(hub: Hub, demo: Awaited<ReturnType<typeof startDemoBot>>, { activity = 'Running the browser test' }: { activity?: string | null } = {}) {
  const { ownerUserId, botUserId, guildId } = hub.options.config
  await hub.twin.prisma.user.update({ where: { id: ownerUserId }, data: { username: 'alice', globalName: 'alice' } })
  const room = (await demo.website.guild.channels.create({ name: 'pairing', type: ChannelType.GuildVoice })) as VoiceChannel
  const spoken = (content: string) => hub.twin.simulateUserMessage({ channelId: room.id, userId: ownerUserId, content, flags: MessageFlags.IsVoiceMessage })
  await spoken('Open the voice code and tell me why the call timer starts again after a reconnect.')
  await room.send('Looking at how the room keeps its start time.')
  for (const step of STEPS) await room.send(step)
  await room.send('The start time lives in the socket session, so every reconnect makes a new one. I moved it beside the room state in `voice.ts`. It now survives a reconnect, and `voice.test.ts` passes.')
  await spoken('Good. Run the browser test as well, then commit.')
  await room.send('Running `voice.browser.test.ts` now. I will commit once it is green.')
  await room.send({ flags: MessageFlags.IsComponentsV2, components: [{ type: 17, accent_color: 0x22c55e, components: [{ type: 10, content: 'Committed `3f9c2e1` on **main**: keep the call timer across reconnects.' }] } as never] })
  // The agent is in the room, as the hub records anyone who joins.
  await hub.twin.setUserVoiceChannel({ userId: botUserId, guildId, channelId: room.id })
  demo.bot.user!.setPresence({ activities: activity ? [{ type: ActivityType.Custom, name: 'Custom Status', state: activity }] : [] })
  // The agent answers what is typed into the room's chat.
  demo.bot.on('messageCreate', (message) => {
    if (!message.author.bot && message.channel.id === room.id) void room.send(`Got it: ${message.content}`)
  })
  return room
}
