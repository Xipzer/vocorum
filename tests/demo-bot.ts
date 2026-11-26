// A discord.js bot that fills a hub with Kimaki-shaped content (categories,
// project channels, session threads, Components V2 callouts, footers,
// questions, buttons, modals, slash commands) for browser tests and demos.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type TextChannel,
} from 'discord.js'
import type { Hub } from '../src/hub.ts'

const CALLOUT = (accent: number, text: string) => ({ type: 17, accent_color: accent, components: [{ type: 10, content: text }] })

export async function startDemoBot(hub: Hub) {
  // Named like the category it creates: agent bots name a category after their machine.
  const minted = await hub.store.addBot('workstation')
  await hub.reload()
  const { guildId, ownerUserId } = hub.options.config
  const bot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    rest: { api: `${hub.localUrl}/api`, version: '10' },
  })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  const guild = await bot.guilds.fetch(guildId)

  const category = await guild.channels.create({ name: 'workstation', type: ChannelType.GuildCategory })
  const kimaki = (await guild.channels.create({ name: 'kimaki', type: ChannelType.GuildText, parent: category.id, topic: '~/code/kimaki' })) as TextChannel
  const website = (await guild.channels.create({ name: 'website', type: ChannelType.GuildText, parent: category.id })) as TextChannel

  // A session thread like Kimaki's: started from the owner's message.
  const starter = await hub.twin.simulateUserMessage({ channelId: kimaki.id, userId: ownerUserId, content: 'Fix the footer that goes missing after short turns' })
  const thread = await kimaki.threads.create({ name: 'Fix footer on short turns', startMessage: starter.id })
  await thread.send(
    [
      '## Found it',
      'The reducer skipped turns with **no text**, so they never got a footer. Fixed in `thread-reducer.ts`:',
      '```ts',
      "if (turn.parts.length === 0) return { ...view, footer: footerFor(turn) }",
      '```',
      '- added a test for empty turns',
      '- snapshots updated, `pnpm run test --run` passes',
      '-# *kimaki ⋅ main ⋅ 2m 30s ⋅ 12% ⋅ claude-opus-5-5*',
    ].join('\n'),
  )
  await thread.send({ flags: MessageFlags.IsComponentsV2, components: [CALLOUT(0xf59e0b, '`bun test src/cli.test.ts` still fails in **CLI Node.js Debugger**. The tests for my change pass.') as never] })
  await thread.send({
    content: '**Question:** Which strategy should I use for the migration?',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('strategy')
          .setPlaceholder('Pick a strategy')
          .addOptions({ label: 'Rebase', value: 'rebase', description: 'Linear history' }, { label: 'Squash', value: 'squash', description: 'One commit' }),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('commit').setLabel('Commit changes').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('other').setLabel('Other…').setStyle(ButtonStyle.Secondary),
      ),
    ],
  })
  const older = await kimaki.threads.create({ name: 'Add hub PWA', autoArchiveDuration: 60 })
  await older.send('Done. Archived for now.')
  await older.setArchived(true)
  await website.send('Deployed **kimaki.dev** ✅')

  await guild.commands.set([
    { name: 'model', description: 'Change the model for this session' },
    { name: 'pick-model', description: 'Set a model by name', options: [{ name: 'model', description: 'Model', type: 3, required: true, autocomplete: true }] },
    { name: 'accounts', description: 'Show your connected accounts' },
    { name: 'new-session', description: 'Start a new session', options: [{ name: 'prompt', description: 'Prompt', type: 3, required: true }] },
    { name: 'abort', description: 'Stop the current run' },
  ])

  const models = ['claude-opus-5-5', 'claude-sonnet-5', 'gpt-6', 'gemini-4-pro']
  const modelPicker = (second: boolean) => new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId('choose-model').setPlaceholder('Select a model').addOptions(
      { label: second ? '← Previous page (1/2)' : 'Next page (2/2) →', value: second ? 'prev' : 'next' },
      ...Array.from({ length: 12 }, (_, i) => { const n = i + (second ? 13 : 1); return { label: `Studio ${n}`, description: `studio-${n}`, value: `studio-${n}` } }),
    ),
  )
  const modelPrompt = '**Set model preference**\nProvider: **Studio**\nSelect a model:'
  bot.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      const typed = interaction.options.getFocused().toLowerCase()
      await interaction.respond(models.filter((m) => m.includes(typed)).map((m) => ({ name: m, value: m })))
    } else if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'accounts') await interaction.reply({ flags: MessageFlags.Ephemeral, content: '**Studio**\n- Workspace · active\n- Sandbox · usage limit until noon\n**Local**\n- On device · active\n-# Accounts are refreshed on the next request.' })
      else if (interaction.commandName === 'model') {
        await interaction.deferReply()
        await interaction.editReply({ content: modelPrompt, components: [modelPicker(false)] })
      } else if (interaction.commandName === 'pick-model') await interaction.reply({ content: `Model set to **${interaction.options.getString('model')}** for this session.` })
      else await interaction.reply({ content: `Running /${interaction.commandName}` })
    } else if (interaction.isButton() && interaction.customId === 'other') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('other-answer')
          .setTitle('Your answer')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('answer').setLabel('Your answer').setStyle(TextInputStyle.Paragraph))),
      )
    } else if (interaction.isButton()) {
      await interaction.update({ components: [] })
      await interaction.followUp({ flags: MessageFlags.IsComponentsV2, components: [CALLOUT(0x22c55e, 'Committed `affdd529` and pushed.') as never] })
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'choose-model') {
        const value = interaction.values[0]!
        if (value === 'next' || value === 'prev') await interaction.update({ content: modelPrompt, components: [modelPicker(value === 'next')] })
        else await interaction.update({ content: `**Set model preference**\nModel: **Studio / ${value}**\nSelect a thinking level:`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('level').setPlaceholder('Select a thinking level').addOptions({ label: 'Standard', value: 'standard' }, { label: 'Extended', value: 'extended' }))] })
      } else if (interaction.customId === 'level') {
        const model = /Studio \/ ([\w-]+)/.exec(interaction.message.content)?.[1] ?? 'studio'
        const effort = interaction.values[0]!
        await interaction.update({ content: `Model set for this session:\n**Studio** / **${model}** (${effort})\n\`studio/${model} (${effort})\`\nApplies from the next step.`, components: [] })
      } else await interaction.update({ content: `**Question:** Which strategy should I use for the migration?\n-# answered: ${interaction.values.join(', ')}`, components: [] })
    } else if (interaction.isModalSubmit()) {
      await interaction.reply({ content: `You answered: ${interaction.fields.getTextInputValue('answer')}` })
    }
  })
  bot.on('messageCreate', async (message) => {
    if (message.author.bot || message.channel.id !== thread.id) return
    await thread.sendTyping()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // A test may end and stop the bot during that pause; a reply then has nowhere to go.
    if (!bot.isReady()) return
    await thread.send(`Got it: ${message.content || 'your voice message'}\n-# *kimaki ⋅ main ⋅ <1s ⋅ 12% ⋅ claude-opus-5-5*`).catch(() => {})
  })

  return { bot, kimaki, website, thread, stop: () => bot.destroy() }
}
