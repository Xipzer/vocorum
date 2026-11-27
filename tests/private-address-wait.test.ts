// At boot the tailnet address can appear after the hub starts. The hub then serves on
// loopback and keeps trying the address, rather than exiting and restarting in a loop.
import { afterAll, expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub | undefined

afterAll(async () => {
  await hub?.stop()
  await t?.cleanup()
})

test('an address that is not on this machine yet does not stop the hub', async () => {
  t = await startTestHub()
  await t.hub.stop()
  // 192.0.2.1 is reserved for documentation: never an address of this machine.
  const config = initHub(t.paths, { privateListener: { address: '192.0.2.1', port: 0, httpPort: 0, names: ['hub.home.arpa'], allowedCidrs: ['192.0.2.0/24'] } })
  hub = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  const errors: string[] = []
  const log = console.error
  console.error = (...args: unknown[]) => void errors.push(args.join(' '))
  try {
    await hub.start()
  } finally {
    console.error = log
  }
  expect(errors.some((e) => e.includes('192.0.2.1 is not on this machine yet'))).toBe(true)
  expect((await fetch(`http://127.0.0.1:${hub.port}/`, { headers: { host: `localhost:${hub.port}` } })).status).toBeLessThan(500)
  await hub.stop()
  hub = undefined
})
