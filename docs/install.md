# Install

This sets up the hub on one computer and signs in your first device.

## What you need

- A computer that stays on, running Linux or macOS. This is the hub.
- Node.js 22 or newer, pnpm (no pnpm? run `corepack enable`), and `openssl`. `ffmpeg` is optional, for voice
  notes from phones.
- A private network between the hub and your other devices, such as Tailscale or
  WireGuard. Vocorum is never meant to be reachable from the internet.

## 1. Install

```bash
git clone https://github.com/Xipzer/vocorum && cd vocorum
pnpm install
pnpm build
node bin/vocorum.js setup --dry-run
```

`--dry-run` shows what setup will do and changes nothing. Read it, then:

```bash
node bin/vocorum.js setup
```

Setup:

- finds the hub's private address (Tailscale, then WireGuard),
- makes the hub's own certificate for that address and the machine's name,
- starts the hub as a service that comes back after a restart,
- checks everything with `doctor`,
- prints a link and a QR code to sign in your first device.

Check the names in the dry run before you go ahead. Changing the hub's first
name later means a new certificate on every device and new passkeys.

Setup also adds a `vocorum` command, so from now on you can type `vocorum`
instead of `node bin/vocorum.js`. It makes an empty server called Home to start
with.

Your data and keys live in `~/.vocorum`. Set `VOCORUM_DIR` to keep them
somewhere else. If another hub already uses the port, setup stops: pick another
with `--port`.

On Linux, run `loginctl enable-linger "$USER"` if setup asks for it, so the hub
keeps running after you log out.

## 2. Sign in on a device

Setup printed a pairing link. For more devices, on the hub:

```bash
node bin/vocorum.js pair my-phone
```

The link works once, for 30 minutes. On the device, connected to your private
network:

1. Scan the QR code or open the link. It opens the hub's setup page.
2. Install the certificate so the device trusts your hub:
   - **iPhone or iPad:** download the profile, then Settings, Profile
     Downloaded, Install. Then Settings, General, About, Certificate Trust
     Settings, and turn on Vocorum CA.
   - **Mac:** download the Mac profile and install it in System Settings,
     General, Device Management.
   - **Windows, Linux, Android:** download `vocorum-ca.crt` and add it as a
     trusted certificate.
3. Open the app from the setup page (Safari on Apple devices). The pairing code
   is already filled in: choose Pair this device and create the passkey.
4. Add it to your home screen (iPhone: Share, Add to Home Screen) or Dock (Mac:
   File, Add to Dock).
5. Turn on notifications in the app's settings if you want them.

Next time, the device signs in with its passkey.

The setup page shows a fingerprint. If you want to be sure the certificate is
yours, compare it with `node bin/vocorum.js private status` on the hub.

## Check it works

```bash
node bin/vocorum.js doctor
node bin/vocorum.js devices list    # your device, and when it was last seen
```

`doctor` checks every part and, for anything wrong, prints the command that
fixes it.

## Update

```bash
git pull
pnpm install
pnpm build
vocorum restart
vocorum doctor
```

## When something goes wrong

Run `node bin/vocorum.js doctor` first. Then:

| What you see | What to do |
|---|---|
| The device can't open the setup page | Check the device is on your private network. |
| Safari says the connection isn't private | Turn on full trust for Vocorum CA (step 2). |
| The app's address is not found | Use the app link from the setup page, not a typed name. |
| The pairing link is refused | Links work once and expire. Run `pair` again. |
| Everything is slow | Something big is running, usually an import. Check `discord status`. |

To see every connection that reaches the hub, add
`Environment=VOCORUM_DEBUG_PRIVATE=1` to the service and read
`journalctl --user -u vocorum`.
