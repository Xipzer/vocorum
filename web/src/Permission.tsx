// Kimaki's permission prompt ("⚠️ **Permission Required**", Type, Pattern, three buttons)
// as an approval card: what the agent wants to do in plain words, the exact command in
// a copyable block, Accept / Accept Always / Deny, and once decided, what was decided.

import { useState } from 'react'
import type { Component } from './api.ts'
import type { Interact } from './components.tsx'
import { Icon, type IconName } from './icons.tsx'

export type PermissionAsk = { type: string; patterns: string[]; from: string | null; outside: boolean; outcome: 'accepted' | 'always' | 'rejected' | 'expired' | 'dismissed' | null }

const HEAD = /^\s*⚠️?\s*\*\*Permission Required\*\*/i

export function parsePermission(content: string): PermissionAsk | null {
  if (!HEAD.test(content)) return null
  const field = (name: string) => new RegExp(`\\*\\*${name}:\\*\\*\\s*\`([^\`]*)\``).exec(content)?.[1] ?? null
  const type = field('Type')
  if (!type) return null
  const pattern = field('Pattern')
  const outcome = /accepted\*\*\s*\(auto-approve/i.test(content) ? 'always' : /accepted\*\*/i.test(content) ? 'accepted' : /rejected\*\*/i.test(content) ? 'rejected' : /expired/i.test(content) ? 'expired' : /dismissed/i.test(content) ? 'dismissed' : null
  return { type, patterns: pattern ? pattern.split(', ').filter(Boolean) : [], from: field('From'), outside: /outside the project/i.test(content), outcome }
}

// What the agent asks for, in plain words, by OpenCode's permission type.
const ASKS: Record<string, { title: string; icon: IconName }> = {
  bash: { title: 'Run this command?', icon: 'key' },
  edit: { title: 'Change these files?', icon: 'pencil' },
  write: { title: 'Write these files?', icon: 'pencil' },
  read: { title: 'Read these files?', icon: 'file' },
  external_directory: { title: 'Work outside the project?', icon: 'warn' },
  webfetch: { title: 'Fetch from the web?', icon: 'external' },
  websearch: { title: 'Search the web?', icon: 'search' },
  task: { title: 'Start a helper agent?', icon: 'members' },
  doom_loop: { title: 'Keep going? It is repeating itself.', icon: 'warn' },
}

const OUTCOMES = {
  accepted: { text: 'Accepted', icon: 'check' as const, tone: 'ok' },
  always: { text: 'Accepted, and similar requests from now on', icon: 'check' as const, tone: 'ok' },
  rejected: { text: 'Denied', icon: 'close' as const, tone: 'off' },
  expired: { text: 'Expired, so it was denied', icon: 'close' as const, tone: 'off' },
  dismissed: { text: 'Dismissed when a new message was sent', icon: 'close' as const, tone: 'off' },
}

export function PermissionCard({ ask, components, interact }: { ask: PermissionAsk; components?: Component[]; interact: Interact }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const what = ASKS[ask.type] ?? { title: `Allow ${ask.type.replace(/_/g, ' ')}?`, icon: 'key' as const }
  const buttons = (components ?? []).flatMap((row) => (row.type === 1 ? (row['components'] ?? []) : [])).filter((c: Component) => c.type === 2 && c['custom_id'] && !c['disabled'])
  const id = (kind: string) => buttons.find((b: Component) => String(b['custom_id']).startsWith(`permission_${kind}:`))?.['custom_id'] as string | undefined
  const press = (customId: string | undefined) => {
    if (!customId || busy) return
    setBusy(customId)
    void interact({ type: 'button', customId }).finally(() => setBusy(null))
  }
  const decided = ask.outcome ? OUTCOMES[ask.outcome] : null
  const open = !decided && buttons.length > 0
  const text = ask.patterns.join('\n')
  return (
    <div className={`approval${open ? ' open' : ''}${decided ? ` ${decided.tone}` : ''}`}>
      <div className="approval-head">
        <Icon name={what.icon} size={16} />
        <b>{what.title}</b>
        {ask.from && <span className="approval-from">for {ask.from}</span>}
      </div>
      {ask.outside && <p className="approval-note">This is outside the project folder.</p>}
      {text && (
        <div className="approval-code">
          <code>{text}</code>
          <button
            className="icon-button"
            onClick={() => {
              void navigator.clipboard?.writeText(text)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            }}
            aria-label="Copy"
            title={copied ? 'Copied' : 'Copy'}
          >
            <Icon name={copied ? 'check' : 'copy'} size={16} />
          </button>
        </div>
      )}
      {open ? (
        <div className="approval-actions">
          <button className="button success" disabled={Boolean(busy)} onClick={() => press(id('once'))}>
            Accept
          </button>
          {id('always') && (
            <button className="button" disabled={Boolean(busy)} onClick={() => press(id('always'))} title="Accept this and similar requests from now on">
              Always
            </button>
          )}
          <button className="button" disabled={Boolean(busy)} onClick={() => press(id('reject'))}>
            Deny
          </button>
        </div>
      ) : (
        decided && (
          <div className="approval-outcome">
            <Icon name={decided.icon} size={14} />
            {decided.text}
          </div>
        )
      )}
    </div>
  )
}
