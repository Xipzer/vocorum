// Screenshots for the README and docs, from a throwaway hub filled with
// invented content. Nothing here reads your own hub.
//   pnpm build:web && node --import tsx scripts/demo-screenshots.ts [outDir]
// Needs a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from 'playwright-core'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
  type TextChannel,
} from 'discord.js'
import { hubPaths, initHub, readSecret, saveConfig } from '../src/config.ts'
import { ADMIN_GUILD_NAME, ADMIN_MACHINE, shieldPng } from '../src/admin.ts'
import { Hub } from '../src/hub.ts'

const out = path.resolve(process.argv[2] ?? 'docs/images')
const webDir = path.resolve(import.meta.dirname, '../web/dist')
const LOGIN = 'you@example.com'
const FOOTER = (time: string, pct: number) => `-# *kimaki ⋅ main ⋅ ${time} ⋅ ${pct}% ⋅ claude-opus-5-5*`
const CALLOUT = (accent: number, text: string) => ({ type: 17, accent_color: accent, components: [{ type: 10, content: text }] })

function findChromium() {
  if (process.env['PLAYWRIGHT_CHROMIUM']) return process.env['PLAYWRIGHT_CHROMIUM']
  const cache = path.join(os.homedir(), '.cache/ms-playwright')
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : []
  for (const dir of dirs) {
    const bin = path.join(cache, dir, 'chrome-linux64/chrome')
    if (fs.existsSync(bin)) return bin
  }
  throw new Error('No Chromium found. Set PLAYWRIGHT_CHROMIUM.')
}

async function machineBot(hub: Hub, name: string, guildId = hub.options.config.guildId) {
  const minted = await hub.store.addBot(name)
  if (guildId !== hub.options.config.guildId) await hub.store.setBotGuilds(name, [guildId])
  await hub.reload()
  const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], rest: { api: `${hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  return { bot, guild: await bot.guilds.fetch(guildId) }
}

// The demo hub never lists this machine's own services.
process.env['VOCORUM_SYSTEMCTL'] = 'false'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-demo-'))
const paths = hubPaths(root)
const config = initHub(paths, { tailscaleLogin: LOGIN })
const hub = new Hub({ paths, config, port: 0, webDir })
await hub.start()
const owner = config.ownerUserId
const say = (channelId: string, content: string) => hub.twin.simulateUserMessage({ channelId, userId: owner, content })

const desk = await machineBot(hub, 'workstation')
const lap = await machineBot(hub, 'laptop')

// Owner channels at the top.
const general = (await desk.guild.channels.fetch()).find((c) => c?.type === ChannelType.GuildText) as TextChannel

const deskCat = await desk.guild.channels.create({ name: 'workstation', type: ChannelType.GuildCategory })
const vocorum = (await desk.guild.channels.create({ name: 'vocorum', type: ChannelType.GuildText, parent: deskCat.id, topic: '~/code/vocorum' })) as TextChannel
const website = (await desk.guild.channels.create({ name: 'website', type: ChannelType.GuildText, parent: deskCat.id, topic: '~/code/website' })) as TextChannel
const lapCat = await lap.guild.channels.create({ name: 'laptop', type: ChannelType.GuildCategory })
const dotfiles = (await lap.guild.channels.create({ name: 'dotfiles', type: ChannelType.GuildText, parent: lapCat.id, topic: '~/dotfiles' })) as TextChannel
const recipes = (await lap.guild.channels.create({ name: 'recipe-app', type: ChannelType.GuildText, parent: lapCat.id, topic: '~/code/recipe-app' })) as TextChannel

// An archived session for history.
const old = await vocorum.threads.create({ name: 'Fix flaky gateway test', autoArchiveDuration: 60 })
await old.send(`Fixed. The test waited on a timer instead of the READY event.\n${FOOTER('4m 02s', 9)}`)
await old.setArchived(true)

// A finished session.
const s1 = await say(vocorum.id, 'Add alt text to image attachments, like Discord does')
const t1 = await vocorum.threads.create({ name: 'Alt text for attachments', startMessage: s1.id })
await t1.send(
  [
    '## Done',
    'Images now carry **alt text** from the composer to the message and the lightbox.',
    '```ts',
    "const alt = attachment.description?.trim() || attachment.filename",
    '```',
    '- added `description` to the upload form',
    '- the lightbox shows it under the image',
    '- `pnpm test` passes (134 tests)',
    FOOTER('6m 41s', 18),
  ].join('\n'),
)
await t1.send({ flags: MessageFlags.IsComponentsV2, components: [CALLOUT(0x22c55e, 'Committed `4e1c9a2` on `main`. Not pushed.') as never] })
await say(t1.id, 'Looks good. Push it and update the changelog.')
await t1.send(`Pushed, and added a line under **Unreleased** in \`CHANGELOG.md\`.\n${FOOTER('38s', 19)}`)

// A session waiting on you.
const s2 = await say(website.id, 'Move the site off the old host, keep the URLs')
const t2 = await website.threads.create({ name: 'Move site to static hosting', startMessage: s2.id })
await t2.send(
  [
    'I built the site as static files and checked every old URL against the new build: **212 of 212** resolve.',
    '',
    'Two ways to keep the old blog links:',
    '1. **Redirects file** at the host. Simple, one file.',
    '2. **Copy pages** to the old paths. No host config, but duplicate pages.',
    FOOTER('3m 15s', 22),
  ].join('\n'),
)
const question = await t2.send({
  content: '**Question:** How should old blog links keep working?',
  components: [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('links').setPlaceholder('Pick one').addOptions({ label: 'Redirects file', value: 'redirects', description: 'Recommended' }, { label: 'Copy pages', value: 'copy' }),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('go').setLabel('Use redirects').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('other').setLabel('Other…').setStyle(ButtonStyle.Secondary),
    ),
  ] as never,
})

// The laptop's channels.
const s3 = await say(dotfiles.id, 'Why is my shell slow to start?')
const t3 = await dotfiles.threads.create({ name: 'Slow shell startup', startMessage: s3.id })
await t3.send(`Most of the 1.4 s goes to loading the version manager on every start. I made it load on first use: startup is now **0.18 s**.\n${FOOTER('2m 50s', 11)}`)
await t3.send({ flags: MessageFlags.IsComponentsV2, components: [CALLOUT(0xf59e0b, 'One plugin still prints a warning on start. I left it alone: it comes from the plugin, not your config.') as never] })
await say(t3.id, 'Can you silence that warning anyway?')
await t3.send(`Done. It now loads with \`--quiet\`, so the start is clean.\n${FOOTER('41s', 12)}`)
await recipes.send(`Nightly tests passed 96 tests, 41 s.`)

await say(general.id, 'Morning. Anything blocked overnight?')
await general.send({ content: 'Morning. One thing needs you: the site move is waiting on how to handle old blog links. Everything else finished.' })
await website.send('Preview build ready: 212 pages, 0 broken links')

await desk.guild.commands.set([
  { name: 'model', description: 'Change the model for this session', options: [{ name: 'model', description: 'Model', type: 3, required: true, autocomplete: true }] },
  { name: 'new-session', description: 'Start a new session', options: [{ name: 'prompt', description: 'Prompt', type: 3, required: true }] },
  { name: 'abort', description: 'Stop the current run' },
])

const token = readSecret(paths.adminToken)
const admin = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${hub.localUrl}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return (await res.json()) as any
}

// A friend on the hub, and a direct message with them.
const alex = (await admin('POST', '/admin/people', { username: 'alex', guilds: [config.guildId] })).user as { id: string }
await hub.twin.simulateUserUpdate({ userId: alex.id, globalName: 'Alex' })

// Reminders and a scheduled message.
const hour = 3600_000

// The Admin server: only you and your admin agent.
const adminGuild = (await hub.store.addGuild(ADMIN_GUILD_NAME)).id
saveConfig(paths, { ...config, adminGuildId: adminGuild, adminBotReady: true })
await hub.reload()
await fetch(`${hub.localUrl}/admin/mirror/guilds/${adminGuild}/icon`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: shieldPng() })
const adminBot = await machineBot(hub, ADMIN_MACHINE, adminGuild)
const adminChannel = (await adminBot.guild.channels.create({ name: 'admin', type: ChannelType.GuildText })) as TextChannel
await say(adminChannel.id, 'Let Robin into the server to review the docs, and sign out the old laptop. It was stolen.')
const robin = await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${config.guildId}/invites`, body: { username: 'robin' }, reason: 'Robin reviews the docs before the release', origin: 'admin' })
await adminChannel.send(`I asked to invite robin. Approve it here: https://hub.example/#/requests/${robin.id}`)
await adminChannel.send('The old laptop was last seen 3 days ago. Revoking it signs it out at once.')
await adminChannel.send({
  content: '⚠️ **Permission Required**\n**Type:** `bash`\n**Pattern:** `vocorum devices revoke old-laptop`',
  components: [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('permission_once:demo').setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('permission_always:demo').setLabel('Accept Always').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('permission_reject:demo').setLabel('Deny').setStyle(ButtonStyle.Secondary),
    ),
  ] as never,
})

fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: findChromium() })

async function device(viewport: { width: number; height: number }, scale: number, userAgent?: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport, serviceWorkers: 'block', deviceScaleFactor: scale, colorScheme: 'dark', ...(userAgent && { userAgent }) })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  return page
}
const origin = `http://localhost:${hub.port}`
async function shot(page: Page, name: string) {
  const { width, height } = page.viewportSize()!
  await page.mouse.move(width < 600 ? width / 2 : 300, width < 600 ? 30 : height - 160)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(out, `${name}.png`) })
}

const page = await device({ width: 1440, height: 900 }, 2)
await page.goto(origin)
await page.getByText('Sign in with passkey').waitFor()
await shot(page, 'pair')
await page.getByLabel('Pairing code').fill(await hub.store.createPairing('Desktop'))
await page.getByText('Pair this device').click()
await page.locator('.sidebar').waitFor()
await page.evaluate(() => fetch('/client/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ global_name: 'Sam' }) }))
await page.goto(`${origin}/#/overview`)
await page.reload()
await page.getByText(/^Needs you/).first().waitFor()
await page.waitForTimeout(500)
await shot(page, 'overview')

await page.goto(`${origin}/#/c/${t1.id}`)
await page.getByText('Pushed, and added').waitFor()
await page.waitForTimeout(500)
await shot(page, 'thread')

await page.goto(`${origin}/#/c/${t2.id}`)
await page.getByText('How should old blog links').waitFor()
await page.waitForTimeout(500)
await shot(page, 'question')

const box = page.getByPlaceholder(/^Message /)
await box.fill('/mo')
await page.locator('.slash-item').first().waitFor()
await page.waitForTimeout(300)
await shot(page, 'slash-commands')
await box.fill('')

// A direct message with a friend.
const dm = (await page.evaluate(async (id) => (await (await fetch('/client/dms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipient_id: id }) })).json()) as { id: string }, alex.id)).id
await hub.twin.simulateUserMessage({ channelId: dm, userId: alex.id, content: 'Is the site move done? I want to send the new link round.' })
await say(dm, 'Nearly. One question left about the old blog links, then it ships.')
await hub.twin.simulateUserMessage({ channelId: dm, userId: alex.id, content: 'Great, ping me when it is live' })
await page.goto(`${origin}/#/c/${dm}`)
await page.getByText('ping me when it is live').waitFor()
await page.waitForTimeout(500)
await shot(page, 'dms')

// Reminders and scheduled messages, with the Scheduled panel open.
const schedule = (body: unknown) => page.evaluate(async (b) => void (await fetch('/client/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })), body)
const tomorrow9 = new Date(Date.now() + 24 * hour)
tomorrow9.setHours(9, 0, 0, 0)
await schedule({ kind: 'reminder', channel_id: t2.id, message_id: question.id, at: Date.now() + 3 * hour })
await schedule({ kind: 'message', channel_id: t2.id, content: 'Run the link check again and post the result', at: tomorrow9.getTime() })
await schedule({ kind: 'message', channel_id: t2.id, content: 'Weekly: summarise what changed on the site', at: tomorrow9.getTime(), cron: `0 ${tomorrow9.getUTCHours()} * * 1` })
await page.goto(`${origin}/#/c/${t2.id}`)
await page.getByText('How should old blog links').waitFor()
await page.locator('.chat-header button[aria-label="More"]').click()
await page.locator('.sheet-item', { hasText: /^Scheduled/ }).click()
await page.locator('.side-panel').getByText('Run the link check').waitFor()
await page.waitForTimeout(500)
await shot(page, 'reminders')
await page.keyboard.press('Escape')

// The Admin server: ask in plain words, approve in place.
await page.goto(`${origin}/#/c/${adminChannel.id}`)
await page.locator('.approval.open').waitFor()
await page.locator('.inline-requests .request-card').waitFor()
await page.waitForTimeout(500)
await shot(page, 'admin')

// Inviting a friend: an account and a pairing code for their first device.
await page.goto(`${origin}/#/c/${general.id}`)
await page.locator('.side-title').click()
await page.locator('.sheet-item', { hasText: 'Server settings' }).click()
await page.getByRole('dialog').getByRole('button', { name: 'Members', exact: true }).click()
const settings = page.getByRole('dialog')
await settings.getByRole('button', { name: 'Invite a person' }).click()
await settings.getByRole('textbox', { name: 'Username' }).fill('jordan')
await settings.getByRole('textbox', { name: 'Display name' }).fill('Jordan')
await settings.getByRole('button', { name: 'Create invite' }).click()
await settings.getByText('Jordan enters it').waitFor()
await page.waitForTimeout(500)
await shot(page, 'invite')
await page.keyboard.press('Escape')

// The desktop app (its window on Windows: the app's own title bar and controls).
const app = await device({ width: 1440, height: 900 }, 2, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
// A stand-in for the app's bridge, so the page draws the app's window chrome. As a string:
// tsx's helpers don't exist in the page.
// Its event channel says hello at once, so the page shows itself connected.
await app.context().addInitScript({
  content: "let cb = null; window.__TAURI_INTERNALS__ = { metadata: {}, transformCallback: (f) => ((cb = f), 1), invoke: async (cmd) => { if (cmd === 'events_subscribe') setTimeout(() => cb && cb({ index: 0, message: { t: 'HELLO', d: {} } }), 0); return cmd === 'window_maximized' ? false : null } }",
})
await app.context().addCookies(await page.context().cookies())
await app.goto(`${origin}/#/c/${t1.id}`)
await app.getByText('Pushed, and added').waitFor()
await app.waitForTimeout(500)
await shot(app, 'desktop-app')

const phone = await device({ width: 390, height: 844 }, 3)
await phone.goto(origin)
await phone.getByLabel('Pairing code').fill(await hub.store.createPairing('iPhone'))
await phone.getByText('Pair this device').click()
await phone.locator('.sidebar').waitFor({ state: 'attached' })
await phone.goto(`${origin}/#/c/${t3.id}`)
await phone.getByText('startup is now').waitFor()
await phone.waitForTimeout(500)
await shot(phone, 'phone-thread')
await phone.getByRole('button', { name: 'Channels' }).click()
await phone.locator('.sidebar.open').waitFor()
await phone.waitForTimeout(400)
await shot(phone, 'phone-channels')

await browser.close()
await desk.bot.destroy()
await lap.bot.destroy()
await adminBot.bot.destroy()
await hub.stop()
fs.rmSync(root, { recursive: true, force: true })
console.log(`Screenshots in ${out}`)
process.exit(0)
