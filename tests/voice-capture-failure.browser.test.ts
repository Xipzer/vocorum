// Only the first browser's microphone pipeline is fault-injected. Both users,
// sockets, worklet (on recovery), output players and paired TLS listener are real.
import { createHash, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { pairedDevice, startTestHub, TestDevice, waitFor } from './helpers.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache)
  .filter(s => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .map(s => path.join(cache, s, 'chrome-linux64/chrome')).find(s => fs.existsSync(s)) : undefined)

function writeTone(file: string, hz: number) {
  const rate = 48000, pcm = Buffer.alloc(44 + 2 * rate)
  pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(2 * rate, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34)
  pcm.write('data', 36); pcm.writeUInt32LE(2 * rate, 40)
  for (let i = 0; i < rate; i++) pcm.writeInt16LE(Math.round(8500 * Math.sin(i * 2 * Math.PI * hz / rate)), 44 + 2 * i)
  fs.writeFileSync(file, pcm)
}

type Level = { hz: number; rms: number; playing: boolean }
type Fault = 'module' | 'partial' | 'acquisition'
declare global {
  interface Window {
    captureTestOutput: () => Level | null
    captureTestFault: {
      arm: (fault: Fault) => void
      release: () => void
      inspect: () => { held: boolean; tracks: MediaStreamTrackState[]; released: string[]; encoder: string | null }
    }
  }
}

// Sample what the app attached to its output player. The observer branch has
// zero gain; it never feeds an input or emits audio to the hub.
function observeOutput() {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')!
  let context: AudioContext | undefined
  window.captureTestOutput = () => null
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { ...descriptor, set(stream: MediaStream | null) {
    descriptor.set!.call(this, stream)
    if (!(this instanceof HTMLAudioElement)) return
    if (context) { void context.close(); context = undefined }
    window.captureTestOutput = () => null
    if (!stream) return
    const ctx = context = new AudioContext({ sampleRate: 48000 }), meter = ctx.createAnalyser(), quiet = ctx.createGain()
    meter.fftSize = 4096; meter.smoothingTimeConstant = 0; quiet.gain.value = 0
    ctx.createMediaStreamSource(stream).connect(meter).connect(quiet).connect(ctx.destination)
    void ctx.resume()
    window.captureTestOutput = () => {
      const time = new Float32Array(meter.fftSize), bins = new Float32Array(meter.frequencyBinCount)
      meter.getFloatTimeDomainData(time); meter.getFloatFrequencyData(bins)
      let peak = 0
      for (let i = 1; i < bins.length; i++) if (bins[i]! > bins[peak]!) peak = i
      return { hz: peak * ctx.sampleRate / meter.fftSize, rms: Math.sqrt(time.reduce((a, x) => a + x*x, 0) / time.length), playing: !this.paused }
    }
  } })
}

// Keep genuine tracks and nodes. Faults are armed for just one requested join.
function injectCaptureFaults() {
  let next: Fault | null = null, resume: (() => void) | null = null, encoder: AudioEncoder | null = null
  const tracks: MediaStreamTrack[] = [], released: string[] = []
  const media = navigator.mediaDevices, get = media.getUserMedia.bind(media)
  media.getUserMedia = async opts => {
    const stream = await get(opts)
    tracks.push(...stream.getAudioTracks())
    if (next === 'acquisition') { next = null; await new Promise<void>(resolve => { resume = resolve }) }
    return stream
  }
  const load = AudioWorklet.prototype.addModule
  AudioWorklet.prototype.addModule = function(url, options) {
    if (next !== 'module' || new URL(url, location.href).pathname !== '/voice-worklet.js') return load.call(this, url, options)
    next = null
    return new Promise<void>((_, reject) => { resume = () => reject(new Error('Fixture: unavailable capture worklet')) })
  }
  function watch(resource: object, method: string, label: string) {
    Reflect.set(resource, method, new Proxy(Reflect.get(resource, method), {
      apply(fn, self, args) { released.push(label); return Reflect.apply(fn, self, args) }
    }))
  }
  MediaStreamAudioSourceNode.prototype.connect = new Proxy(MediaStreamAudioSourceNode.prototype.connect, {
    apply(fn, source, args) {
      const result = Reflect.apply(fn, source, args), node = args[0]
      if (next === 'partial' && node instanceof AudioWorkletNode) {
        watch(source, 'disconnect', 'source'); watch(node, 'disconnect', 'worklet'); watch(node.port, 'close', 'port')
        if (!('AudioEncoder' in window)) { next = null; throw new Error('Fixture: capture connection failed') }
      }
      return result
    }
  })
  if ('AudioEncoder' in window) {
    const configure = AudioEncoder.prototype.configure
    AudioEncoder.prototype.configure = function(config) {
      if (next === 'partial') { next = null; encoder = this; throw new Error('Fixture: encoder setup failed') }
      return configure.call(this, config)
    }
  }
  window.captureTestFault = {
    arm: fault => { next = fault },
    release: () => { if (!resume) throw new Error('No held operation'); const fn = resume; resume = null; fn() },
    inspect: () => ({ held: resume !== null, tracks: tracks.map(t => t.readyState), released, encoder: encoder?.state ?? null })
  }
}

const controls = (p: Page) => p.getByRole('toolbar', { name: 'Voice controls' })
const inspect = (p: Page) => p.evaluate(() => window.captureTestFault.inspect())
const arm = (p: Page, fault: Fault) => p.evaluate(f => window.captureTestFault.arm(f), fault)
const release = (p: Page) => p.evaluate(() => window.captureTestFault.release())
const level = (p: Page) => p.evaluate(() => window.captureTestOutput())
const hearing = (p: Page, hz: number) => waitFor(async () => {
  const m = await level(p)
  return m?.playing && m.rms > .012 && Math.abs(m.hz - hz) < 22 && m
})
const join = (p: Page) => controls(p).getByRole('button', { name: 'Join voice' }).click()
const leave = (p: Page) => controls(p).getByRole('button', { name: 'Leave voice' }).click()

test.skipIf(!executablePath || !fs.existsSync(path.join(webDir, 'index.html')))('capture startup failure releases the microphone, preserves playout and cannot mute a later join', async () => {
  const t = await startTestHub({ extensions: [] }), browsers: Browser[] = [], errors: string[] = []
  try {
    await t.hub.stop()
    const host = 'hub.home.arpa', config = initHub(t.paths, { privateListener: { address: '127.0.0.1', names: [host], port: 0, httpPort: null, allowedCidrs: ['127.0.0.0/8'] } })
    t.hub = new Hub({ paths: t.paths, config, port: 0, webDir, extensions: [] }); await t.hub.start()
    const listener = t.hub.privateListener!, origin = `https://${host}:${listener.port}`
    const cert = new X509Certificate(fs.readFileSync(listener.files.cert)), pin = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    const first = await pairedDevice(t.hub, 'Test microphone'), login = 'listener@example.test'
    const invite = await first.json(`/client/guilds/${config.guildId}/invites`, { method: 'POST', json: { username: 'listener' } })
    await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: login }); await t.hub.refreshLogins()
    const second = new TestDevice(t.hub, { 'tailscale-user-login': login }); await second.pair(invite.code)
    const room = await t.hub.twin.simulateChannelCreate({ guildId: config.guildId, type: 2, name: 'Test call' })
    async function page(device: TestDevice, hz: number, controlled: boolean) {
      const file = path.join(t.paths.root, `tone-${hz}.wav`); writeTone(file, hz)
      const b = await chromium.launch({ executablePath, args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${pin}`,
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`, '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] })
      browsers.push(b)
      const ctx = await b.newContext({ permissions: ['microphone'], serviceWorkers: 'block' }), cookie = device.cookie!, i = cookie.indexOf('=')
      await ctx.addCookies([{ name: cookie.slice(0, i), value: cookie.slice(i+1), secure: true, httpOnly: true, url: origin }])
      await ctx.addInitScript(observeOutput)
      if (controlled) await ctx.addInitScript(injectCaptureFaults)
      const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', e => errors.push(e.message))
      await p.goto(`${origin}/#/c/${room.id}`); return p
    }
    const [a, b] = await Promise.all([page(first, 440, true), page(second, 760, false)])
    const states = async () => (await second.json('/client/state')).voice_states as Array<{ user_id: string; self_mute: boolean; self_deaf: boolean; channel_id: string }>
    const peerSees = (mute: boolean) => waitFor(async () => {
      const rows = await states()
      return rows.length === 2 && rows.some(r => r.user_id === config.ownerUserId && r.channel_id === room.id && r.self_mute === mute && !r.self_deaf) && rows.some(r => r.user_id === invite.user.id && !r.self_mute && !r.self_deaf)
    })
    async function listenOnly() {
      try { await a.getByRole('alert').filter({ hasText: 'Microphone capture is unavailable' }).waitFor() }
      catch (cause) {
        const diagnostic = { status: await a.locator('.voice-strip-status').allTextContents(), alerts: await a.locator('.voice-error').allTextContents(),
          tracks: (await inspect(a)).tracks, peerSawMute: (await states()).find(r => r.user_id === config.ownerUserId)?.self_mute, errors }
        throw new Error(`No listen-only transition: ${JSON.stringify(diagnostic)}`, { cause })
      }
      expect(await a.locator('.voice-strip-status').innerText()).toContain('Listen-only')
      expect(await controls(a).getByRole('button', { name: 'Unmute', exact: true }).isDisabled()).toBe(true)
      expect(await a.locator('.voice-strip').getByRole('button', { name: 'Unmute', exact: true }).isDisabled()).toBe(true)
      expect((await inspect(a)).tracks.every(state => state === 'ended')).toBe(true)
      await peerSees(true); await b.locator('.voice-tile-name .voice-flag').waitFor()
      expect(await b.locator('.voice-error').count()).toBe(0)
      // The healthy user hears no return from the failed microphone. Its own
      // tone is nevertheless audible at the failed user's actual output.
      const heard = await hearing(a, 760)
      const quiet = await waitFor(async () => { const m = await level(b); return m?.playing && m.rms < .004 && m })
      return { heard, quiet }
    }
    await join(b); await arm(a, 'module'); await join(a)
    await waitFor(async () => (await inspect(a)).held); await peerSees(false)
    expect((await inspect(a)).tracks).toEqual(['live'])
    await release(a)
    const failed = await listenOnly()

    // Fail later in startup too, after the stream and worklet are connected.
    await leave(a); await arm(a, 'partial'); await join(a); await listenOnly()
    const partial = await inspect(a)
    expect(partial.released.sort()).toEqual(['port', 'source', 'worklet'])
    expect(partial.encoder).toBe(await a.evaluate(() => 'AudioEncoder' in window) ? 'closed' : null)

    // A late rejection from another call by the same user in the very same
    // room must neither stop the replacement mic nor publish a mute on its WS.
    await leave(a); await arm(a, 'module'); await join(a); await waitFor(async () => (await inspect(a)).held)
    await leave(a); expect((await inspect(a)).tracks).toEqual(['ended', 'ended', 'ended'])
    await join(a); await hearing(b, 440); await release(a)
    const recovered = await Promise.all([hearing(a, 760), hearing(b, 440)]); await peerSees(false)
    expect((await inspect(a)).tracks).toEqual(['ended', 'ended', 'ended', 'live'])
    expect(await a.locator('.voice-error').count()).toBe(0)
    expect(await controls(a).getByRole('button', { name: 'Mute', exact: true }).isEnabled()).toBe(true)

    // A permission result can also return after rejoining the same channel.
    await leave(a); await arm(a, 'acquisition'); await join(a); await waitFor(async () => (await inspect(a)).held)
    await leave(a); await join(a); await hearing(b, 440); await release(a)
    await expect.poll(async () => (await inspect(a)).tracks.slice(-2)).toEqual(['ended', 'live'])
    await peerSees(false); await hearing(a, 760); await hearing(b, 440)
    await Promise.all([leave(a), leave(b)]); await waitFor(async () => (await states()).length === 0)
    expect((await inspect(a)).tracks.every(x => x === 'ended')).toBe(true); expect(errors).toEqual([])
    console.log('Voice capture fixture:', JSON.stringify({ failed, partial, recovered, staleModuleIgnored: true, staleMicrophoneReleased: true, usersAfterLeave: 0 }))
  } finally { await Promise.all(browsers.map(b => b.close())); await t.cleanup() }
}, 60_000)
