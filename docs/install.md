# Install

This sets up the hub on one computer and signs in your first device.

Just want to look first? [Try it on this computer](try-it.md) in two commands, with no certificate,
code or passkey. Come back here when you want your phone or other devices.
[Security levels](security-levels.md) explains what each step protects.

## What you need

- A computer that stays on, running Linux, macOS or Windows. This is the hub.
- Node.js 22.16 or newer, git and `openssl`. `ffmpeg` is optional, for voice
  notes from phones. Setup installs the packages and builds the app by itself.
- A private network between the hub and your other devices, such as Tailscale or
  WireGuard. Vocorum is never meant to be reachable from the internet.

## 1. Install

```bash
git clone https://github.com/Xipzer/vocorum && cd vocorum
node bin/vocorum.js setup --dry-run
```

`--dry-run` shows what setup will do. It only fetches the packages it needs to
run and changes nothing else. Read it, then:

```bash
node bin/vocorum.js setup
```

Setup:

- installs the packages and builds the app (the first time, a minute or two),
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
somewhere else. If another hub already runs on this computer, setup picks
free ports and says so.

On Linux, run `loginctl enable-linger "$USER"` if setup asks for it, so the hub
keeps running after you log out. Without systemd (a container, or WSL without
it) setup runs the hub in the background instead. It then does not start again
after a reboot: `doctor` prints the line to add for that.

### On macOS

`openssl` is already there. Setup adds a launchd agent, so the hub starts when
you log in and comes back if it stops.

### On Windows

Install Node.js 22.16 or newer, Git for Windows (it brings `openssl`) and
Tailscale. Then, in a normal terminal (not as administrator):

```bat
git clone https://github.com/Xipzer/vocorum
cd vocorum
node bin\vocorum.js setup
```

- Setup adds a Task Scheduler task for your user. It starts the hub when you log
  in, with no window, and starts it again if it stops. The log is
  `%USERPROFILE%\.vocorum\hub.log`.
- The hub only runs while you are logged in.
- Setup adds a `vocorum` command for you.

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

**Using the desktop or iPhone app instead?** Run
`node bin/vocorum.js pair my-laptop --app` and open the link on that device. The
app needs no certificate, DNS or passkey steps: the link tells it which
certificate to trust. See [apps/desktop/README.md](../apps/desktop/README.md).

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

Your hub checks for a new version every six hours. When there is one, the
hub's owner sees an update button at the bottom left of the app. It opens
**Settings > Updates > Your hub**, which lists what changed.

- **Update now** installs it. The hub backs itself up, installs the new version and restarts. The app reconnects after a few seconds and reloads.
- **Update automatically** lets the hub install new versions by itself, when no agent is in the middle of a turn.
- **Check now** asks straight away.

From a terminal on the hub computer:

```bash
vocorum update --check   # what is new, nothing changes
vocorum update           # shows what is new, asks, installs
```

If an update fails at any step, the hub goes back to the version it had and
starts again. The reason is in `update.log` in the hub's folder, and the
backup taken before it is in `backups/pre-update-<time>`.

Good to know:

- Updates come from the place you cloned the hub from. A check is one small request; nothing else is sent.
- `vocorum config set updates off` stops the checks; `notify` turns them back on; `auto` is the same as the switch in the app. Restart the hub afterwards.
- If you changed files in the checkout, or added your own commits, the hub does not update itself: use git as you would for any fork.
- The desktop app updates separately, from your hub: **Settings > Updates > This app**.

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
