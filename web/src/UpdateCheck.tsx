// The desktop app's updates: a dialog opened by "Check for Updates…" (app menu, tray
// and Settings) that says what is installed, what the hub offers and what changed, with
// one button to install it; and the Updates page in Settings.

import { useEffect, useRef, useState } from 'react'
import { appInfo, invoke, native } from './native.ts'
import { Group, Item, Page, Switch } from './SettingsKit.tsx'
import './update-check.css'

export const desktopUpdates = native && !/iPhone|iPad|Android/.test(navigator.userAgent)
const requestUpdateCheck = () => window.dispatchEvent(new Event('vocorum-settings-update-check'))

type Found = { version: string; notes?: string }

export function UpdateCheck() {
  const dialog = useRef<HTMLDialogElement>(null)
  const [installed, setInstalled] = useState('')
  const [status, setStatus] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [installing, setInstalling] = useState(false)
  useEffect(() => {
    if (!desktopUpdates) return
    let active = true, checking = false
    const check = async () => {
      if (!active) return
      if (!dialog.current?.open) dialog.current?.showModal()
      if (checking) return
      checking = true
      setFound(null); setInstalling(false); setStatus('Checking your hub…')
      try {
        setInstalled((await appInfo()).version)
        const update = await invoke<Found | null>('check_app_update')
        if (!active) return
        setFound(update)
        setStatus(update ? `Version ${update.version} is ready to install.` : "You're up to date.")
      } catch (e) { if (active) setStatus(String(e)) }
      finally { checking = false }
    }
    const consume = () => void invoke<boolean>('take_update_check').then(asked => { if (asked && active) void check() }).catch(() => {})
    window.addEventListener('vocorum-update-check', consume)
    window.addEventListener('vocorum-settings-update-check', check)
    // Works even when choosing the native menu had to create a new window.
    queueMicrotask(() => { if (active) consume() })
    return () => { active = false; window.removeEventListener('vocorum-update-check', consume); window.removeEventListener('vocorum-settings-update-check', check) }
  }, [])
  // The app downloads the signed build, installs it and restarts itself.
  const install = () => {
    setInstalling(true); setStatus(`Installing version ${found!.version}. Vocorum restarts when it's done.`)
    invoke('install_app_update').catch((e) => { setInstalling(false); setFound(null); setStatus(String(e)) })
  }
  return desktopUpdates ? <dialog className="update-check" ref={dialog} aria-labelledby="update-check-heading" onCancel={(e) => { if (installing) e.preventDefault() }}>
    <header className="modal-header"><h2 id="update-check-heading">Vocorum updates</h2></header>
    <div className="modal-body">
    {installed && <p>Installed on this device: {installed}</p>}
    <p role="status">{status}</p>
    {found && <section><h3>What changed</h3><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{found.notes?.trim() || 'No release notes were provided.'}</p></section>}
    </div>
    <form method="dialog" className="modal-footer">
      {found && !installing && <button className="button" autoFocus={false}>Later</button>}
      {found ? <button type="button" className="button primary" autoFocus disabled={installing} onClick={install}>Restart to update</button> : <button className="button primary" autoFocus>Done</button>}
    </form>
  </dialog> : null
}

export function UpdatesPage() {
  const [auto, setAuto] = useState<boolean | null>(null)
  useEffect(() => { void invoke<boolean>('auto_update').then(setAuto).catch(() => setAuto(false)) }, [])
  return <Page title="Updates">
    <Group title="This app">
      <Item label="Check for updates" note="Asks your hub for a newer version of this app and shows what changed.">
        <button className="settings-btn" onClick={requestUpdateCheck}>Check for Updates…</button>
      </Item>
      <Item label="Update automatically" note="Installs a new version while the window is closed. With the window open, you choose when to restart.">
        <Switch label="Update automatically" checked={auto === true} disabled={auto === null} onChange={(on) => void invoke<boolean>('auto_update', { enabled: on }).then(setAuto).catch(() => {})} />
      </Item>
    </Group>
  </Page>
}
