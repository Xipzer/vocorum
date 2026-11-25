// Built-in client extensions an edition compiles into the app. Each may add a
// page (#/x/<id>), a row under Overview in the sidebar, a section, a note per
// row and a footer to the Overview, and a section and a count to the Inbox. Hub events reach them through
// store.onEvent. Public Vocorum ships none.

import type { ReactNode } from 'react'
import type { SessionSummary } from './api.ts'

export type ClientExtension = {
  id: string
  title?: string
  Page?: (props: { onMenu: () => void; onOpen: (id: string) => void }) => ReactNode
  SidebarRow?: (props: { active: boolean; onOpen: () => void }) => ReactNode
  OverviewSection?: (props: { onOpen: (id: string) => void }) => ReactNode
  OverviewNote?: (props: { session: SessionSummary }) => ReactNode
  OverviewFooter?: (props: { onOpen: (id: string) => void }) => ReactNode
  InboxSection?: (props: { onOpen: (id: string) => void }) => ReactNode
  // A hook: items in InboxSection, added to the bell's count; the Overview is not empty while any.
  useInboxCount?: () => number
}

export const extensions: ClientExtension[] = []
