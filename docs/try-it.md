# Try it on this computer first

The quickest way to see Vocorum. No certificate, no pairing code, no passkey.

```
git clone https://github.com/Xipzer/vocorum && cd vocorum
node bin/vocorum.js setup --open
```

The first run installs the packages and builds the app by itself (a minute or
two, about 470 MB of packages). Then open the address it prints
(http://localhost:47100) in a browser on the same computer and write a message.
You need Node.js 22.16 or newer and git. Nothing else.

Add `--dry-run` to see what setup would do without changing anything.

## What "open" means

- Only this computer can reach the hub. No phone and no other computer can connect.
- Anyone and any program on this computer can read and post, with no sign-in.
- Don't forward its port to another machine (for example with an SSH tunnel or a port forwarder). That would let the other machine in with no sign-in too.

That is fine for trying it out on a computer you trust. It is your choice at
setup: a hub set up without `--open` always asks every browser to pair.

`vocorum doctor` says "Local access: open" for as long as it is on.

## When you want more

Each step adds to what you have. Your messages stay.

- **Your Discord history:** see [Move from Discord](migrate-from-discord.md). It works the same on an open hub.
- **Your phone or another computer:** run `vocorum setup`. It shows which private address it will open and asks before it does. Then it prints a pairing link. Each device installs the hub's certificate once and makes its own passkey, as in [Install](install.md). This computer stays open at http://localhost. If this computer is on Tailscale, setup uses its Tailscale address, and your devices must be signed in to the same Tailscale account; the plan says so.
- **Pairing on this computer too:** run `vocorum config set localAccess off`, then `vocorum restart`. From then on this computer pairs like any other device, at the hub's own address. Add your devices with `vocorum setup` first: until then the command refuses, because no browser could reach the hub.
- **Open again:** `vocorum config set localAccess open`, then `vocorum restart`.

[Security levels](security-levels.md) lists every level, from open to locked down.

## For agents

- Use `setup --open` only when the person asked to try Vocorum on this one computer. Tell them the two points under "What open means" before you run it.
- Never add `--address` or `--yes` to make an open hub reachable from other devices. Adding devices is `vocorum setup` with the person's yes to the plan it shows.
- `setup --open` does not stop to ask, because it opens nothing to other devices. Say the two points first; `--dry-run` shows the plan.
- Check your work with `vocorum doctor`. On an open hub with no other devices it shows no failures (warnings about no service or no bots are normal): "Local access: open", "Private listener: off" and "Devices: this computer needs no pairing". Without a browser, `curl http://localhost:<port>/client/auth/status` answers with `"open":true`.
- To keep an open hub local when you run setup again (for example to install the service), use `vocorum setup --open`. Plain `vocorum setup` offers to add other devices.
