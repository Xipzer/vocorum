// Built-in extensions an edition compiles into the hub. Each is made with the
// hub, started after everything else and stopped first, and answers its own
// client routes under /client/x/<id>/ (after the device session, Origin and
// identity checks every client route gets). Public Vocorum ships none.

import type http from 'node:http'
import type { Viewer } from './client-api.ts'
import type { Hub } from './hub.ts'

export type HubExtension = {
  id: string
  start?(): Promise<void> | void
  stop?(): Promise<void> | void
  // undefined: not this extension's path. null answers 204, anything else is sent as JSON.
  // The viewer is anyone with a device session: check who they are (access.isHubOwner, access.can).
  handleClient?(req: http.IncomingMessage, pathname: string, viewer: Viewer): Promise<unknown>
}

export type HubExtensionFactory = (hub: Hub) => HubExtension

export const extensions: HubExtensionFactory[] = []
