# Security

## Reporting a vulnerability

Please report privately: use GitHub's "Report a vulnerability" (private security
advisories) on this repository, or email xipzer@proton.me. Do not open a public
issue. Include steps to reproduce and the impact you see. You will get an answer
within a few days, and credit in the advisory if you want it.

## Threat model (summary)

Vocorum holds private conversations between a person and their bots, which often
include source code, logs and credentials pasted by mistake. We assume
attackers are patient and that probing any reachable service is cheap.

**Protected assets:** message history, attachments, bot tokens, device sessions,
the ability to act as the owner towards bots (which may run code on your machines).

**Design decisions:**

- **No public surface.** The server binds loopback, plus at most one specific
  private address (never a wildcard) that drops peers outside the allowed
  networks before TLS. Remote access goes through a private network the owner controls.
- **No third-party trust for TLS.** The optional private listener uses the hub's
  own CA, name constrained to the hub's names and address, under `home.arpa`.
  No public CA, no certificate-transparency entries, no outbound calls.
- **Layered human access.** A network gate (the proxy's identity header on
  loopback, or allowed networks plus an optional Tailscale identity check on
  the private listener), then a per-device passkey that is always required. Devices are enrolled with single-use, time-limited codes
  from the server's own CLI and can be revoked individually.
- **CSRF.** `SameSite=Strict` HttpOnly cookies, `Origin` checks on every
  mutation and WebSocket upgrade.
- **Separation.** Bot credentials and human sessions are separate. Bots are
  scoped to their guild and cannot reach human routes. Event streams to the app
  never include interaction or voice tokens.
- **Files.** Attachments are stored with mode 0600, served with `nosniff` and a
  sandboxing CSP, and only through signed URLs or an authenticated session.
- **Secrets at rest.** Session tokens are stored hashed. Admin actions need a
  local token file and are refused when a request came through a proxy.

**Out of scope:** a compromised owner device or OS account, a malicious bot you
chose to connect (bots act with the permissions you give them), and the
security of the private network you put in front of Vocorum.
