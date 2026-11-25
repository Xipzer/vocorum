// Errors a person can act on, in plain words; the browser's own passkey messages are long
// and technical.
export function loginError(e: unknown) {
  const name = e instanceof Error ? e.name : ''
  const message = e instanceof Error ? e.message : String(e)
  // The browser says the same thing for "cancelled" and "this device has no passkey here".
  if (name === 'NotAllowedError' || name === 'AbortError') return 'No passkey was used. On a new device, pair it with a code below.'
  if (name === 'InvalidStateError') return 'This device already has a passkey for the hub. Sign in instead.'
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "Can't reach the hub. Check this device is on your network."
  if (/(unknown or expired|already used or expired) pairing code|pairing code already used/i.test(message)) return 'Expired, used or not found. On your signed-in device, open User settings > Devices > Pair another device. Enter the fresh code here. Keep it out of chat.'
  if (/challenge expired/i.test(message)) return 'That took too long. Try again.'
  if (/not enrolled or its device was revoked/i.test(message)) return 'This device was signed out. Pair it again with a new code.'
  return message
}

// Approving with a passkey on a device that is already signed in.
export function approvalError(e: unknown) {
  const name = e instanceof Error ? e.name : ''
  if (name === 'NotAllowedError' || name === 'AbortError') return 'No passkey was used, so nothing changed. Approve again when ready.'
  if (name === 'InvalidStateError' || name === 'SecurityError') return "This device's passkey can't approve here. Approve from a device you signed in with a passkey."
  return e instanceof Error ? e.message : String(e)
}
