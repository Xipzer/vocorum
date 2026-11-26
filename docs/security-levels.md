# Security levels

Start as open as you like and add protection when you need it. Each level keeps
your messages and adds to the one before. Nothing here is ever reachable from
the internet: the hub only listens on this computer and, if you ask, on your
private network.

| Level | Who can get in | What it costs you | How |
|---|---|---|---|
| **1. Open on this computer** | Anyone and any program on this computer. No other device, unless you forward the port yourself: do not. | Nothing: no certificate, code or passkey. | `vocorum setup --open` |
| **2. Your devices, paired** | Devices you paired, over your private network (Tailscale, WireGuard or your own address). This computer too if it is still open. | Once per device: install the hub's certificate, enter a one-use code, make a passkey. | `vocorum setup` |
| **3. Every browser pairs** | Only paired devices. Being at this computer is no longer enough. | This computer pairs like any other device. | `vocorum config set localAccess off` |
| **4. Tied to your accounts** | Paired devices that are also on the right Tailscale account: yours for you, each friend's for them. | Devices must be signed in to Tailscale. | Automatic when setup finds Tailscale. Otherwise `vocorum config set tailscaleLogin <login>` |

What you get from level 2 up, without doing anything:

- **Private network only.** The hub answers on one private address and only to the networks you allow.
- **Its own certificate authority.** The hub's names never appear in public certificate logs.
- **One passkey per device.** Lose a phone and you revoke that device alone (Settings, Devices).
- **One account per person.** People you invite see only the servers and channels you give them. See "Invite a friend" in [Daily use](daily-use.md).
- **Agents ask first.** Your admin agent can look, but changes to people, roles and channels wait for you to approve each one with your passkey.

## Going back down

Every step is a command on the hub computer, so only someone at that computer
can loosen it. `vocorum config set localAccess open` makes this computer open
again. To remove the device listener, open this computer first, then run
`vocorum private off`: it refuses otherwise, because no browser could get in.
`vocorum doctor` always says which level you are on.

## What Vocorum does not do yet

- **End-to-end encryption.** The hub can read your messages. Search, notifications and bots depend on that. Keep the hub on a computer you control.
- **A lock on the app itself** (a PIN or Face ID each time you open it).
- **Running the hub as its own system user**, so other programs under your account cannot read its files.
