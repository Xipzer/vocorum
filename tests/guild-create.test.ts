// A bot's GUILD_CREATE is like Discord's: channels without threads, and only
// active threads (an import's thousands of archived threads stay out).

import { Client, GatewayIntentBits } from 'discord.js'
import { afterAll, expect, test } from 'vitest'
import { startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let client: Client | null = null

afterAll(async () => {
  await client?.destroy()
  await t?.cleanup()
})

test('archived threads are not in GUILD_CREATE; active ones are', async () => {
  t = await startTestHub()
  const prisma = t.hub.twin.prisma
  const parent = (await prisma.channel.findFirstOrThrow({ where: { guildId: t.config.guildId, type: 0 } })).id
  await prisma.channel.createMany({
    data: [
      { id: '1400000000000000001', guildId: t.config.guildId, type: 11, name: 'active thread', parentId: parent },
      { id: '1400000000000000002', guildId: t.config.guildId, type: 11, name: 'old thread', parentId: parent, archived: true },
    ],
  })
  const bot = await t.hub.store.addBot('desk-pc')
  await t.hub.reload()
  const raw: Array<{ t: string; d: any }> = []
  client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  client.on('raw', (p: { t: string; d: any }) => void raw.push(p))
  const ready = new Promise<void>((resolve) => client!.once('clientReady', () => resolve()))
  await client.login(`${bot.clientId}:${bot.secret}`)
  await ready
  const guild = raw.find((e) => e.t === 'GUILD_CREATE')!.d
  expect(guild.threads.map((c: { id: string }) => c.id)).toEqual(['1400000000000000001'])
  expect(guild.channels.some((c: { type: number }) => c.type === 11)).toBe(false)
  // An archived thread is still there on request.
  expect((await client.channels.fetch('1400000000000000002'))?.id).toBe('1400000000000000002')
})
