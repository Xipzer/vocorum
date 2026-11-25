// Hub updates: what a hub learns from the place it was cloned from, and who
// may see and start an update. Installing (packages, build, restart, going back
// on failure) is exercised against real checkouts outside this suite.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { hubPaths } from '../src/config.ts'
import { check } from '../src/updates.ts'
import { pairedDevice, startTestHub, TestDevice } from './helpers.ts'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-updates-'))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
const upstream = path.join(work, 'upstream')
const origin = path.join(work, 'origin.git')
const hubRepo = path.join(work, 'hub')
const paths = hubPaths(path.join(work, 'state'))

function publish(title: string, notes: string[], file = 'notes.txt') {
  fs.writeFileSync(path.join(upstream, file), `${title}\n`)
  git(upstream, 'add', '-A')
  git(upstream, 'commit', '-q', '-m', `${title}\n\n${notes.map((n) => `- ${n}`).join('\n')}\n\nSigned-off-by: Test <test@example.invalid>`)
  git(upstream, 'push', '-q', 'origin', 'main')
}

beforeAll(() => {
  fs.mkdirSync(paths.root, { recursive: true })
  fs.mkdirSync(upstream)
  git(upstream, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(upstream, 'notes.txt'), 'first\n')
  git(upstream, 'add', '-A')
  git(upstream, 'commit', '-q', '-m', 'First release\n\n- Everything so far.')
  execFileSync('git', ['clone', '-q', '--bare', upstream, origin])
  git(upstream, 'remote', 'add', 'origin', origin)
  execFileSync('git', ['clone', '-q', origin, hubRepo])
})

afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

test('a hub learns what is new from where it was cloned, with each release\'s notes', async () => {
  const first = await check(paths, hubRepo)
  expect(first).toMatchObject({ supported: true, source: 'origin/main', target: null, available: [], blocked: null, current: { title: 'First release', notes: ['Everything so far.'] } })

  publish('Voice channels', ['Join a voice channel.', 'Bots can speak.'])
  publish('Faster search', ['Search answers in 12 ms.'])
  const found = await check(paths, hubRepo)
  if (!found.supported) throw new Error(found.reason)
  // Newest first, bullet lines only: the sign-off is not a note.
  expect(found.available.map((r) => [r.title, r.notes])).toEqual([['Faster search', ['Search answers in 12 ms.']], ['Voice channels', ['Join a voice channel.', 'Bots can speak.']]])
  expect(found.target).toBe(git(upstream, 'rev-parse', 'HEAD'))
  expect(found.blocked).toBeNull()
  // Checking changed nothing in the checkout.
  expect(git(hubRepo, 'log', '-1', '--format=%s')).toBe('First release')
  expect(JSON.parse(fs.readFileSync(path.join(paths.root, 'update.json'), 'utf8')).checked.available).toHaveLength(2)
})

test('a checkout changed by hand is told so; a fork or a checkout with no remote is left alone', async () => {
  fs.writeFileSync(path.join(hubRepo, 'notes.txt'), 'my own edit\n')
  const dirty = await check(paths, hubRepo)
  expect(dirty).toMatchObject({ supported: true, blocked: expect.stringMatching(/changed by hand \(notes\.txt\)/) })
  git(hubRepo, 'checkout', '-q', 'notes.txt')

  // Its own commit on top: someone's fork. No update is offered and nobody is nagged.
  fs.writeFileSync(path.join(hubRepo, 'mine.txt'), 'private feature\n')
  git(hubRepo, 'add', '-A')
  git(hubRepo, 'commit', '-q', '-m', 'My own feature')
  expect(await check(paths, hubRepo)).toMatchObject({ supported: false, reason: expect.stringMatching(/commits of its own/) })
  // The same when the remote has nothing new: a fork never contacts its remote.
  git(hubRepo, 'reset', '-q', '--hard', 'origin/main')
  git(hubRepo, 'pull', '-q', '--ff-only')
  fs.writeFileSync(path.join(hubRepo, 'mine.txt'), 'private feature\n')
  git(hubRepo, 'add', '-A')
  git(hubRepo, 'commit', '-q', '-m', 'My own feature')
  git(hubRepo, 'remote', 'set-url', 'origin', path.join(work, 'gone.git'))
  expect(await check(paths, hubRepo)).toMatchObject({ supported: false, reason: expect.stringMatching(/commits of its own/) })

  const alone = path.join(work, 'alone')
  fs.mkdirSync(alone)
  git(alone, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(alone, 'a.txt'), 'a\n')
  git(alone, 'add', '-A')
  git(alone, 'commit', '-q', '-m', 'Only commit')
  expect(await check(paths, alone)).toMatchObject({ supported: false, reason: expect.stringMatching(/no remote/) })
  expect(await check(paths, work)).toMatchObject({ supported: false, reason: expect.stringMatching(/not installed with git/) })
})

test('only the hub owner sees or starts updates, and nothing can be installed when nothing is new', async () => {
  const t = await startTestHub()
  try {
    const owner = await pairedDevice(t.hub, 'owner-laptop')
    const seen = await owner.json('/client/hub/update')
    expect(seen).toMatchObject({ mode: 'notify', run: null })
    expect((await owner.fetch('/client/hub/update', { method: 'POST', json: {} })).status).toBe(409)
    expect((await owner.fetch('/client/hub/update', { method: 'PUT', json: { mode: 'weekly' } })).status).toBe(400)
    expect((await owner.json('/client/hub/update', { method: 'PUT', json: { mode: 'auto' } })).mode).toBe('auto')
    expect(JSON.parse(fs.readFileSync(t.paths.config, 'utf8')).updates).toBe('auto')
    expect((await owner.json('/client/hub/update', { method: 'PUT', json: { mode: 'notify' } })).mode).toBe('notify')

    const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'sam' } })
    await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: 'sam@example.org' })
    await t.hub.refreshLogins()
    const sam = new TestDevice(t.hub, { 'tailscale-user-login': 'sam@example.org' })
    await sam.pair(invite.code)
    for (const [method, route] of [['GET', '/client/hub/update'], ['POST', '/client/hub/update'], ['POST', '/client/hub/update/check'], ['PUT', '/client/hub/update']] as const) {
      expect((await sam.fetch(route, { method, ...(method !== 'GET' && { json: { mode: 'auto' } }) })).status).toBe(403)
    }
  } finally {
    await t.cleanup()
  }
})
