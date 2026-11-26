---
name: vocorum-security
description: Move a Vocorum hub between its security levels (1 open on this computer, 2 paired devices, 3 every browser pairs, 4 tied to Tailscale accounts), up or down, and say which level it is on. Use when someone asks to secure, lock down, loosen, open up, add a phone or other device to, or check the security of a Vocorum hub.
---

# Vocorum security levels

The levels are in `docs/security-levels.md`. Each one keeps every message and adds to the one
before. You move a hub between them with a few commands on the hub computer.

Run every command on the hub computer, from the checkout: `vocorum <command>` once setup has
put it on PATH, otherwise `node bin/vocorum.js <command>`. Add `--json` when you want to read
the result.

## Rules

- **Never make the hub reachable from the internet.** No `tailscale funnel`, `tailscale serve`,
  port forwarding, SSH tunnels or `socat` for the hub port. Not even to test.
- **Opening the private listener (going to level 2) needs the person's yes in chat**, after they
  have seen the plan `vocorum setup` prints. Never pass `--yes` before that.
- **Before going down a level, say what the person loses**, in one sentence, and wait for a yes.
- Never print secrets (tokens, keys, `~/.vocorum/admin-token`). Never edit `config.json` by hand.
- **One yes per step, up or down.** Each step changes who gets in: say what changes in one
  sentence and wait for a yes. Moving two levels is two steps and two yeses.
- Pairing codes and links are not secrets: give them to the person. Each works once, for 30
  minutes, and an unused one simply expires.
- Run `vocorum doctor --json` after every step. Its `security-level` line must show the level
  you meant to reach. A `fail` line means stop and do what its fix says. Warnings about no
  service, no bots, no paired devices yet, or the app name not resolving on the hub computer
  are normal right after setup and can stay (the name only matters if this computer will pair).

## 1. Find the level

```bash
vocorum doctor --json
```

Read the `security-level` check, for example `level 2 of 4, your paired devices, and this
computer with no sign-in (next: vocorum config set localAccess off)`. Tell the person the
level in plain words and what the next one would add. Do not change anything yet.

## 2. Going up

| From → to | Tell the person first | Commands |
|---|---|---|
| 1 → 2 | Setup will open the hub on one private address (their Tailscale or other private network address) so their own devices can pair. Each device installs the hub's certificate once, opens a one-use link and makes a passkey. This computer stays open. | `vocorum setup --dry-run`, show them the plan, then after their yes `vocorum setup --yes`. Setup finds the private address itself; pass `--address <ip>` only when the person names one. Setup ends with a pairing link (the setup page link, for a browser on the first device; for the desktop or iPhone app, use `vocorum pair <name> --app` instead). For each further device, `vocorum pair <device name>`. The steps on the device are in `docs/install.md`, "2. Sign in on a device". |
| 2 → 3 | This computer will have to pair like any other device. | First check that a device has finished pairing: doctor's `devices` line shows at least `1 paired`. If this computer should keep working, pair it too, at the hub's own address, the same way as any device (`vocorum pair this-computer`, steps in the same section; if the app address does not open on this computer, doctor names the fix). Then `vocorum config set localAccess off` and `vocorum restart`. The command refuses while no device has finished pairing: pair one, do not look for a way around it. If the person cannot finish pairing now, leave the hub on level 2, say so, and tell them `vocorum pair <name>` gives a fresh link later. |
| 3 → 4 | Only devices signed in to their Tailscale account get in, as well as needing a passkey. Only possible when the listener is on a Tailscale address. | Setup usually did this already when it found Tailscale; doctor says so. Otherwise read their login from `tailscale status --json`: `User[<Self.UserID>].LoginName`. Then `vocorum config set tailscaleLogin <login>` and `vocorum restart`. Friends need nothing: the hub learns each friend's account when they pair with their invite (`docs/daily-use.md`, "Invite a friend"). |

Going from 1 straight to 3 or 4 is the same steps in order; check doctor between them.

## 3. Going down

| From → to | What the person loses | Commands |
|---|---|---|
| 4 → 3 | Devices no longer have to be on their Tailscale account. A passkey is still needed. | `vocorum config set tailscaleLogin none`, then `vocorum restart`. |
| 3 → 2 | Anyone and any program on this computer can read and post at http://localhost:<port> with no sign-in. | `vocorum config set localAccess open`, then `vocorum restart`. |
| 2 → 1 | No phone or other computer can connect any more. Paired devices stay on the list, and work again if the listener comes back; remove one with `vocorum devices revoke <name>`. | `vocorum private off`, then `vocorum restart`. It refuses unless this computer is open (3 → 2 first). The hub's certificate stays for a later `vocorum setup`. |

On an open hub, also tell them: do not forward the hub's port to another machine; whoever
reaches the forward counts as this computer.

## 4. Not available

Say so plainly if asked: end-to-end encryption, a PIN or Face ID lock on the app, and running
the hub as its own system user do not exist yet. Do not improvise them.

## 5. Report

One or two sentences: the level it is on now (doctor's words), what changed for them, and the
next level if they want more.
