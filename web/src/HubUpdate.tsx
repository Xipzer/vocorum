// The hub's own updates, for its owner: an "Update available" button in the user panel,
// and "Your hub" under Settings > Updates with what changed, one button to install it
// and the choice to let the hub do that by itself. The hub does the work (src/updates.ts);
// while it restarts the app reconnects on its own, then reloads to pick up the new build.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type HubUpdate } from './api.ts'
import { Icon } from './icons.tsx'
import { Group, Item, message, Switch } from './SettingsKit.tsx'
import { sessionActions } from './Sheet.tsx'
import { useStore } from './store.ts'
import './hub-update.css'

let current: HubUpdate | null = null
const listeners = new Set<() => void>()
const set = (next: HubUpdate | null) => {
  current = next
  for (const f of listeners) f()
}
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}
const refresh = () => api.hubUpdate().then(set, () => {})
// Sent by the hub when it finds a new version (store.ts passes it on).
if (typeof window !== 'undefined') window.addEventListener('vocorum-hub-update', (e) => set((e as CustomEvent<HubUpdate>).detail))

function useHubUpdate() {
  const owner = useStore((d) => d.state?.hub_owner === true)
  const value = useSyncExternalStore(subscribe, () => current)
  useEffect(() => {
    if (owner && !current) void refresh()
  }, [owner])
  return owner ? value : null
}

const pending = (u: HubUpdate | null) => (u?.checked?.supported && !u.checked.blocked ? u.checked.available : [])
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function HubUpdateBadge() {
  const update = useHubUpdate()
  if (pending(update).length === 0 || update?.run?.status === 'running') return null
  return (
    <button className="icon-button hub-update-badge" onClick={() => sessionActions.settings?.('updates')} aria-label="Update available" title="Update available">
      <Icon name="download" />
    </button>
  )
}

export function HubUpdateGroup() {
  const update = useHubUpdate()
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = busy === 'install' || update?.run?.status === 'running'
  // While the hub installs and restarts, ask until it says how it went. Requests fail for
  // the few seconds it is down; that is expected.
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      void api.hubUpdate().then((next) => {
        set(next)
        if (next.run?.status === 'running') return
        setBusy(null)
        // The new version brings a new app with it.
        if (next.run?.status === 'done') window.setTimeout(() => location.reload(), 1500)
      }, () => {})
    }, 2000)
    return () => window.clearInterval(timer)
  }, [running])
  if (!update) return null
  const act = (what: 'check' | 'install', run: () => Promise<unknown>) => {
    setBusy(what)
    setError(null)
    void run().then(() => what === 'check' && setBusy(null), (e) => (setBusy(null), setError(message(e))))
  }
  const checked = update.checked
  if (checked && !checked.supported)
    return (
      <Group title="Your hub">
        <Item label="Updated by hand" note={checked.reason} />
      </Group>
    )
  const releases = pending(update)
  const failed = update.run?.status === 'failed' ? update.run.error : null
  return (
    <Group title="Your hub">
      <Item
        label={running ? 'Updating…' : releases.length ? (releases.length === 1 ? 'A new version is ready' : `${releases.length} new versions are ready`) : checked ? 'Up to date' : 'Not checked yet'}
        note={running ? 'The hub backs itself up, installs the new version and restarts. This app reconnects by itself.' : checked?.supported ? `You have: ${checked.current.title} (${day(checked.current.date)}).${checked.blocked ? ` ${checked.blocked}` : ''}` : 'The hub checks every six hours.'}
      >
        <div className="settings-actions">
          {releases.length > 0 && (
            <button className="button medium primary" disabled={running} onClick={() => act('install', () => api.hubUpdateInstall())}>
              Update now
            </button>
          )}
          <button className="button medium" disabled={busy !== null || running} onClick={() => act('check', () => api.hubUpdateCheck().then(set))}>
            {busy === 'check' ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </Item>
      {(error || failed) && <p className="settings-feedback bad" role="alert">{error ?? `The last update did not install, and the hub went back to the version it had. ${failed}`}</p>}
      {releases.length > 0 && (
        <div className="settings-list">
          {releases.map((r) => (
            <section key={r.commit} className="settings-list-row">
              <div className="settings-item-text">
                <h4 className="settings-label hub-update-title">
                  {r.title} <span className="settings-tag">{day(r.date)}</span>
                </h4>
                {r.notes.length > 0 && (
                  <ul className="settings-item-note hub-update-notes">
                    {r.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      <Item label="Update automatically" note="The hub installs new versions by itself when no agent is working. Off: it tells you, and you choose when.">
        <Switch label="Update the hub automatically" checked={update.mode === 'auto'} disabled={update.mode === 'off'} onChange={(on) => void api.hubUpdateMode(on ? 'auto' : 'notify').then(set, (e) => setError(message(e)))} />
      </Item>
      {update.mode === 'off' && <p className="settings-note">Update checks are off for this hub (vocorum config set updates notify turns them on).</p>}
    </Group>
  )
}
