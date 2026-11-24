// Optional end-to-end test with Kimaki (https://github.com/remorses/kimaki), an
// OpenCode bot: the unmodified Kimaki CLI connects to the hub with a minted bot
// token, the owner posts from a "device", and the answer comes back over REST + WS.
// OpenCode is isolated (temp XDG dirs, deterministic model, no provider keys).
// Runs only when KIMAKI_REPO points at a Kimaki checkout with its deps installed:
//   KIMAKI_REPO=~/src/kimaki/kimaki pnpm test tests/kimaki.e2e.test.ts
// The voice test also needs a Whisper server and browser-recorded notes (not in the repo):
//   KIMAKI_E2E_WHISPER_URL=http://127.0.0.1:7071/v1 KIMAKI_E2E_VOICE_DIR=<dir with
//   chrome.webm (Chrome, webm/opus) and safari.mp4 (Safari, mp4/aac), both saying the same sentence>

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { LOGIN, pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

const kimakiDir = process.env['KIMAKI_REPO'] ? path.resolve(process.env['KIMAKI_REPO']) : ''
const enabled = Boolean(kimakiDir && fs.existsSync(path.join(kimakiDir, 'src/test/harness.ts')))
type Harness = typeof import('./kimaki-harness.d.ts')
const cli = [process.execPath, '--import', 'tsx', 'src/cli.ts']
const whisperUrl = process.env['KIMAKI_E2E_WHISPER_URL'] ?? ''
const voiceDir = process.env['KIMAKI_E2E_VOICE_DIR'] ?? ''

let t: Awaited<ReturnType<typeof startTestHub>>
let server: Awaited<ReturnType<Harness['startOpencodeTestServer']>>
let bot: ChildProcess
let phone: TestDevice
let env: Record<string, string>
let log = ''

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

const reply = (id: string, text: string) => ({
  id,
  when: { latestUserTextIncludes: id },
  then: {
    parts: [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: text },
      { type: 'text-end', id },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ],
  },
})

beforeAll(async () => {
  if (!enabled) return
  const { startOpencodeTestServer } = (await import(path.join(kimakiDir, 'src/test/harness.ts'))) as Harness
  t = await startTestHub()
  const minted = await t.hub.store.addBot('laptop')
  await t.hub.reload()
  phone = await pairedDevice(t.hub)
  server = await startOpencodeTestServer({ matchers: [reply('hello-marker', 'Hello from OpenCode, through Kimaki, through the private hub.')] as never })
  const dataDir = path.join(server.root, 'kimaki-data')
  fs.mkdirSync(dataDir, { recursive: true })
  // Only env vars point Kimaki at the hub. Never inherit this machine's Kimaki or OpenCode vars.
  env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('KIMAKI_') && !key.startsWith('OPENCODE_'))) as Record<string, string>),
    HOME: path.join(server.root, 'home'),
    XDG_DATA_HOME: path.join(server.root, 'data'),
    XDG_STATE_HOME: path.join(server.root, 'state'),
    XDG_CONFIG_HOME: path.join(server.root, 'config'),
    XDG_CACHE_HOME: path.join(server.root, 'cache'),
    KIMAKI_DATA_DIR: dataDir,
    KIMAKI_LOCK_PORT: String(await freePort()),
    KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile,
    KIMAKI_BOT_TOKEN: `${minted.clientId}:${minted.secret}`,
    KIMAKI_GATEWAY_APP_ID: t.config.botUserId,
    KIMAKI_GATEWAY_PROXY_URL: `ws://127.0.0.1:${t.hub.port}`,
    KIMAKI_WEBSITE_URL: 'http://127.0.0.1:9',
    ...(whisperUrl && { KIMAKI_WHISPER_URL: whisperUrl }),
  }
  bot = spawn(cli[0]!, [...cli.slice(1), '--data-dir', dataDir, '--no-analytics', '--no-autostart', '--coordinator', 'false', '--disable-prompt', 'critique-diffs', '--guild', t.config.guildId], {
    cwd: kimakiDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bot.stdout!.on('data', (chunk: Buffer) => (log += chunk))
  bot.stderr!.on('data', (chunk: Buffer) => (log += chunk))
  await waitFor(() => fs.existsSync(path.join(dataDir, 'kimaki.db')), { timeout: 60_000 })
  // Slash commands are registered once the bot is ready.
  await waitFor(async () => (await phone.json('/client/state')).commands.length > 0, { timeout: 60_000 })
  await promisify(execFile)(cli[0]!, [...cli.slice(1), 'project', 'add', server.projectDirectory, '--guild', t.config.guildId], { cwd: kimakiDir, env, encoding: 'utf8', timeout: 60_000 })
}, 180_000)

afterAll(async () => {
  if (!enabled) return
  bot?.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await server?.kill()
  await t?.cleanup()
}, 30_000)

test.skipIf(!enabled)('The owner talks to OpenCode through Kimaki, through the hub, from a paired device', async () => {
  try {
    const projectName = path.basename(server.projectDirectory).toLowerCase().slice(0, 10)
    const channel = await waitFor(async () => (await phone.json('/client/state')).channels.find((c: { name: string; type: number }) => c.type === 0 && c.name.startsWith(projectName)), { timeout: 30_000 })

    const events: Array<{ t: string; d: any }> = []
    const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { 'tailscale-user-login': LOGIN, origin: phone.origin, cookie: phone.cookie! } })
    ws.on('message', (data) => events.push(JSON.parse(String(data))))
    await waitFor(() => events.some((e) => e.t === 'HELLO'))

    const sent = await phone.json(`/client/channels/${channel.id}/messages`, { method: 'POST', json: { content: 'hello-marker: are you there?' } })
    const thread = await waitFor(async () => (await phone.json('/client/state')).threads.find((th: { parent_id: string }) => th.parent_id === channel.id), { timeout: 60_000 })
    const text = await waitFor(
      async () => {
        const { messages } = await phone.json(`/client/channels/${thread.id}/messages`)
        const all = messages.map((m: { content: string; components?: unknown[] }) => `${m.content} ${JSON.stringify(m.components ?? [])}`).join('\n')
        return all.includes('through the private hub') ? { messages, all } : null
      },
      { timeout: 90_000 },
    )
    expect(text.messages[0].id).toBe(sent.id)
    expect(events.some((e) => e.t === 'THREAD_CREATE' && e.d.id === thread.id)).toBe(true)
    expect(events.some((e) => (e.t === 'MESSAGE_CREATE' || e.t === 'MESSAGE_UPDATE') && e.d.channel_id === thread.id && JSON.stringify(e.d).includes('through the private hub'))).toBe(true)
    ws.close()
  } catch (error) {
    console.error(log.slice(-4000))
    throw error
  }
}, 180_000)

// What each browser's MediaRecorder uploads, through the PWA's upload + send calls.
// The 5-byte file is what Chrome uploads when it stopped before the microphone delivered sound.
test.skipIf(!enabled || !whisperUrl || !voiceDir)('Voice notes from Chrome (webm/opus) and Safari (mp4/aac) are transcribed; an empty recording says so at once', async () => {
  try {
    const projectName = path.basename(server.projectDirectory).toLowerCase().slice(0, 10)
    const channel = await waitFor(async () => (await phone.json('/client/state')).channels.find((c: { name: string; type: number }) => c.type === 0 && c.name.startsWith(projectName)), { timeout: 30_000 })
    const started = await phone.json(`/client/channels/${channel.id}/messages`, { method: 'POST', json: { content: 'hello-marker: voice next' } })
    const thread = await waitFor(async () => {
      const threads = ((await phone.json('/client/state')).threads as Array<{ id: string; parent_id: string }>).filter((th) => th.parent_id === channel.id)
      for (const th of threads) if (((await phone.json(`/client/channels/${th.id}/messages`)).messages as Array<{ id: string }>).some((m) => m.id === started.id)) return th
      return null
    }, { timeout: 60_000 })
    const text = async () => ((await phone.json(`/client/channels/${thread.id}/messages`)).messages as Array<{ content: string }>).map((m) => m.content).join('\n')
    await waitFor(async () => (await text()).includes('through the private hub'), { timeout: 90_000 })
    const sendVoice = async (bytes: Buffer, filename: string, type: string) => {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename)
      form.append('voice', '1')
      form.append('durationSecs', '6')
      form.append('waveform', 'AAEC')
      const attachment = await phone.json('/client/uploads', { method: 'POST', body: form })
      await phone.json(`/client/channels/${thread.id}/messages`, { method: 'POST', json: { content: '', attachmentIds: [attachment.id], voice: true } })
    }
    const cases = [
      { file: 'chrome.webm', filename: 'voice-message.webm', type: 'audio/webm;codecs=opus' },
      { file: 'safari.mp4', filename: 'voice-message.m4a', type: 'audio/mp4' },
    ]
    for (const [index, item] of cases.entries()) {
      await sendVoice(fs.readFileSync(path.join(voiceDir, item.file)), item.filename, item.type)
      // The transcript is echoed under each note; both notes say the same sentence.
      await waitFor(async () => ((await text()).match(/making a transcription/gi) ?? []).length > index, { timeout: 120_000 })
    }
    const startedAt = Date.now()
    await sendVoice(Buffer.from('1c53bb6b80', 'hex'), 'voice-message.webm', 'audio/webm;codecs=opus')
    await waitFor(async () => (await text()).includes('no sound in it'), { timeout: 30_000 })
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  } catch (error) {
    console.error(log.slice(-4000))
    throw error
  }
}, 420_000)
