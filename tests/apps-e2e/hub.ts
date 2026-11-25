// A throwaway hub for the app end-to-end tests: its own folder, a private TLS
// listener on 127.0.0.1 (random ports) for the apps, and the demo bot.

import fs from 'node:fs'
import { initHub } from '../../src/config.ts'
import { Hub } from '../../src/hub.ts'
import { AppReleases } from '../../src/app-releases.ts'
import { appPairLink } from '../../src/private-listener.ts'
import { startTestHub } from '../helpers.ts'
import { startDemoBot } from '../demo-bot.ts'

export async function throwawayHub() {
  const t = await startTestHub()
  await t.hub.stop()
  const config = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: 0, names: ['hub.home.arpa'], allowedCidrs: ['127.0.0.0/8'] } })
  const hub = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  await hub.start()
  const demo = await startDemoBot(hub)
  const listener = hub.privateListener!
  return {
    hub,
    demo,
    ownerId: config.ownerUserId,
    async pairLink(device: string) {
      const link = appPairLink({ ...config.privateListener!, port: listener.port, httpPort: listener.httpPort }, listener.files.caCert, await hub.store.createPairing(device))
      if (!link) throw new Error('the hub has no enrolment port')
      return link
    },
    publish: (dir: string) => new AppReleases(t.paths.apps).publish(dir),
    async stop() {
      await demo.stop()
      await hub.stop()
      fs.rmSync(t.paths.root, { recursive: true, force: true })
    },
  }
}

export type ThrowawayHub = Awaited<ReturnType<typeof throwawayHub>>
