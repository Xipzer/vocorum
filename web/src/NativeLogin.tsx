// The sign-in card inside the app: the same card as the browser's, but the app
// pairs with a link (it carries the hub's address and certificate fingerprint)
// and signs in with its own device key instead of a passkey.

import { useEffect, useState } from 'react'
import { loginError } from './login.ts'
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
      setError(loginError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <div className="login-card">
        <div className="login-head">
          <h1>{paired ? 'Vocorum' : 'Pair this app'}</h1>
          <p>{paired ? new URL(paired).hostname : 'Paste the pairing link from your hub.'}</p>
        </div>
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
          <label className={`login-label${error ? ' bad' : ''}`} htmlFor="pairing-link">
            Pairing link
            {error && <span role="alert"> · {error}</span>}
          </label>
          <input id="pairing-link" className="code-input link" value={link} onChange={(e) => setLink(e.target.value.trim())} placeholder="vocorum://pair…" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          <button className={`button wide${paired === null ? ' primary' : ''}`} disabled={busy || !link.startsWith('vocorum://pair')}>
            Pair this app
          </button>
        </form>
        <p className="login-help">
          No link? On the hub machine, run <code>vocorum pair &lt;device&gt; --app</code>
        </p>
      </div>
    </div>
  )
}
