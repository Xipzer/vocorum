// The sign-in card inside the app: the same card as the browser's, but the app
// pairs with a link (it carries the hub's address and certificate fingerprint)
// and signs in with its own device key instead of a passkey.

import { useEffect, useState } from 'react'
import { appInfo, pairApp, signInApp } from './native.ts'

export function NativeLogin({ onDone }: { onDone: () => void }) {
  const [link, setLink] = useState('')
  const [paired, setPaired] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const load = () =>
      void appInfo()
        .then((i) => {
          setPaired(i.paired ? (i.origin ?? '') : null)
          if (i.pendingLink) setLink(i.pendingLink)
        })
        .catch(() => {})
    load()
    window.addEventListener('vocorum-pair-link', load)
    return () => window.removeEventListener('vocorum-pair-link', load)
  }, [])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <div className="login-card">
        <h1>Vocorum</h1>
        <p className="muted">{paired ? new URL(paired).hostname : 'Private hub'}</p>
        {paired !== null && (
          <>
            <button className="button primary wide" disabled={busy} onClick={() => void run(signInApp)}>
              Sign in
            </button>
            <div className="login-divider">
              <span>Another hub</span>
            </div>
          </>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => pairApp(link))
          }}
        >
          <input className="code-input" value={link} onChange={(e) => setLink(e.target.value.trim())} placeholder="Pairing link" style={{ letterSpacing: 0, fontSize: 13 }} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          <button className={`button wide${paired === null ? ' primary' : ''}`} disabled={busy || !link.startsWith('vocorum://pair')}>
            Pair this device
          </button>
        </form>
        <p className="help">
          Get a link on the hub machine with <code>vocorum devices add &lt;name&gt;</code>
        </p>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  )
}
