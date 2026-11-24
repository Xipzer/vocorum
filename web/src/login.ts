// Errors a person can act on, in plain words; the browser's own passkey messages are long
// and technical.
export function loginError(e: unknown) {
  const name = e instanceof Error ? e.name : ''
  const message = e instanceof Error ? e.message : String(e)
  if (name === 'NotAllowedError' || name === 'AbortError') return 'Passkey cancelled. Try again when ready.'
  if (name === 'InvalidStateError') return 'This device already has a passkey for the hub. Sign in instead.'
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "Can't reach the hub. Check this device is on your network."
  if (/(unknown or expired|already used or expired) pairing code|pairing code already used/i.test(message)) return 'Expired, used or not found. Ask for a new one.'
  if (/challenge expired/i.test(message)) return 'That took too long. Try again.'
  if (/not enrolled or its device was revoked/i.test(message)) return 'This device was signed out. Pair it again with a new code.'
  return message
}
