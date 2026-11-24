# AGENTS.md: setting up Vocorum for a person

You are an AI agent asked to install Vocorum for a person, move them from
Discord, set it up, and clean up their Discord. Follow the steps in order. Each
step says how to check it worked. Do not skip a check.

`setup` puts a `vocorum` command on PATH (`~/.local/bin`). Before that, run
`node bin/vocorum.js` from the checkout. Every command takes `--json`: use it and read the result.
Every command is safe to run twice.

## Rules

- **Never expose the hub without a yes.** Vocorum must never be reachable from
  the internet. Never run `tailscale funnel`, `tailscale serve`, port forwarding
  or tunnels for it. Opening the private listener needs the person's OK in chat.
- **Never print secrets.** Bot tokens, `~/.vocorum/admin-token`, `signing-key`,
  `.env` files, the CA key and Discord tokens stay in files with mode 0600. Check
  them by name or length only. Move them between machines over SSH, never
  through chat.
- **Ask before anything that deletes or cannot be undone:**
  `discord purge --execute`, `bots revoke`, `people remove`, `devices revoke`,
  deleting anything in `~/.vocorum`.
- **Back up first.** Before an import, a purge or an update, stop the hub and
  copy `~/.vocorum/twin.db` and `~/.vocorum/hub.db`.
- **Long jobs never run in your shell.** Use `--detach` and check with
  `vocorum discord status`. A job in your shell dies when your session ends.
- **Run `vocorum doctor --json` after every step.** It names each problem and
  the command that fixes it.
- **Ask everything at the start**, with a default for each answer, then work
  without stopping.

## What to ask first

1. Which computer runs the hub? It should stay on (Linux or macOS).
2. Which private network reaches it: Tailscale (default), WireGuard, or other?
3. Which devices will they use (iPhone, Mac, Android, Windows, Linux)?
4. Which machines run bots, and which bots (Kimaki or other discord.js bots)?
5. Moving from Discord? Which servers (default: all), their Discord user id,
   and whether to clean up Discord afterwards (default: no).
6. May you open the private listener on the hub's private address? (Needs a yes.)

## 1. Prerequisites

```bash
node --version          # 22 or newer
pnpm --version          # missing? corepack enable
openssl version
which ffmpeg            # optional, voice notes from phones
```

## 2. Install

```bash
git clone https://github.com/Xipzer/vocorum && cd vocorum
pnpm install && pnpm build
vocorum setup --dry-run --json
```

Show the person the plan: the address, the names, the allowed networks and the
service file. When they say yes:

```bash
vocorum setup --yes --json
vocorum doctor --json
```

What setup does:

- Picks the address from `tailscale ip -4`, else a WireGuard (`wg*`) interface,
  else loopback only. Never a wildcard. Override with `--address`.
- Uses the machine's Tailscale name first, then `hub.home.arpa`. The
  certificate comes from the hub's own CA, limited to exactly those names, so
  nothing appears in public certificate logs and devices need no DNS setup.
- Writes a systemd user service (macOS: a launchd agent) only if none exists,
  then starts it. It never overwrites a unit someone wrote by hand.
- Prints a 30-minute pairing link and QR code if no device is paired yet.

Get the names right the first time. Changing the first name later means a new
CA, reinstalling the certificate on every device and new passkeys, because a
passkey is tied to the name. Running `setup` again keeps an existing hub's
names and prints the command to switch, with that warning.

If another hub holds the port, setup refuses: use `--port N`. Setup starts an
empty server called Home. After an import the person has Home plus their old
servers.

Check: `doctor` exits 0. On Linux, if it warns about linger, run
`loginctl enable-linger "$USER"`.

Data lives in `~/.vocorum` (`VOCORUM_DIR` overrides): folder 0700, secrets 0600.

## 3. Sign in their devices

```bash
vocorum pair <device name> --json      # 30 minutes; --ttl up to 24h
```

It prints the pairing code, a setup link by IP address
(`http://<IP>:47080/?code=...`), a QR code and an app link. The setup page opens
the app with the code filled in. Give the person the code too, in case they
need to type it. Always start a device at the setup link: it works before the
device trusts the hub or knows its name.

Give the person these steps for their device:

- **iPhone or iPad:** open the setup link in Safari. Download the profile, then
  Settings, Profile Downloaded, Install. Then Settings, General, About,
  Certificate Trust Settings, turn on Vocorum CA. Back in Safari open the app
  from the setup page, tap Pair this device, create the passkey. Then Share, Add to Home
  Screen. Notifications only work from the home screen app.
- **Mac:** open the setup link in Safari, download the Mac profile, install it in
  System Settings, General, Device Management. Open the app link, pair, then
  File, Add to Dock.
- **Windows, Linux, Android:** download `vocorum-ca.crt` from the setup page,
  add it as a trusted certificate, open the app link and pair.

Check: `vocorum devices list --json` shows the device with a recent last seen
time.

## 4. Connect bots

Each machine gets its own bot token. For Kimaki on the hub machine, use
`kimaki setup` alone. For any other bot or machine, mint the token with:

```bash
vocorum bots add <machine> --out ~/.vocorum/<machine>.env
```

The file holds the bot's token (shown once, stored hashed) and the hub's
address.

- **Kimaki on the hub machine:** `vocorum kimaki setup <machine>` does it all:
  mints the bot token into `~/.vocorum/<machine>.env`, makes the data folder
  `~/.vocorum/kimaki-data`, picks a free `KIMAKI_LOCK_PORT`, writes the
  `kimaki-hub` service (with `KillMode=mixed` and the CA) and starts it. Use
  `--kimaki <path>` if Kimaki is not on PATH. It refuses if the machine already
  has a hub bot or the service exists. On its first start Kimaki opens an
  onboarding thread and starts a model run on a free model with a low limit:
  set the person's usual model with `/model` in the app.
- **Kimaki on another machine:** copy the `.env` file and `~/.vocorum/ca/ca.crt`
  over SSH, set `NODE_EXTRA_CA_CERTS` to the CA file, and check the machine
  reaches the hub before starting Kimaki:
  `curl --cacert ca.crt https://<hub name>:47443/client/auth/status`.
- **Other discord.js bots:** log in with the token from the file and set
  `rest: { api: '<hub URL>/api' }` on the client.
- One Kimaki talks to one place. Running the same Kimaki on Discord and Vocorum
  at once is not supported in upstream Kimaki.

To write the Kimaki service by hand instead, see the unit `kimaki setup` writes
in `~/.config/systemd/user/kimaki-hub.service`. Keep `KillMode=mixed`: without
it a stop kills Kimaki twice and the unit ends as failed.

Check: `vocorum bots list --json` shows the bot. In the app the machine's
category appears. A message in a project channel gets an answer in a new thread.

## 5. Move history from Discord

Do this before any cleanup, and when nobody is pairing a device.

```bash
vocorum config set ownerDiscordIds <their Discord user id>
vocorum discord scan all --kimaki --json
```

The Discord user id: Discord, Settings, Advanced, Developer Mode on, right click
their name, Copy User ID. Without it their old messages show under their Discord
name.

Token: `--kimaki` uses this machine's Kimaki bot. Otherwise `--token-file <file>`
(mode 0600) or `DISCORD_BOT_TOKEN`. With `--detach`, use a file or `--kimaki`.

With no server id, `scan` covers every server the bot is in. Read the scan with
the person:

- Message Content intent off: other people's messages would import empty. They
  turn it on in the Discord developer portal, the app, Bot, Privileged Gateway
  Intents.
- Channels the bot cannot read: give the bot access on Discord, or accept they
  stay behind.
- The time estimate.

Then:

```bash
vocorum discord import all --kimaki --detach --json
vocorum discord status --json
```

- It runs outside the hub, in small batches, and slows down when the hub is
  busy.
- It keeps Discord's ids, copies files, avatars and icons, and marks old
  history as read.
- It can be stopped and resumed. A channel only counts as done when every
  message and file arrived.
- Secrets it finds are masked in `~/.vocorum/import/report.json`. Tell the
  person which ones to change.

Check: `discord status` says finished with no gaps. `doctor` shows no import
gaps. Open old threads in the app: messages and pictures load.

## 6. Configure

```bash
vocorum config get --json
vocorum config set ownerUsername <name>        # then: vocorum restart
vocorum guilds add '<server name>'             # one per former Discord server
vocorum bots guilds <machine> 'Home,<server name>'
vocorum machines icon <machine> avatar <image>
```

Changes that give someone more access go through a request. The owner approves
it in the app with their passkey. You never approve.

```bash
vocorum request invite <username> --guild Home --reason '<why>'
vocorum request role <username> <role name>
vocorum request channel <channel> <username|role> --allow view,send
vocorum requests list --json
```

- Requests wait 24 hours, then expire.
- Only the owner can create or give the `kimaki` and `no-kimaki` roles. Anyone
  who can talk to Kimaki can run commands on that machine.
- `doctor` lists everyone besides the owner who can drive agents.

Be honest with the person about one limit: an agent running as the same OS user
as the hub can read the hub's files. Requests protect against mistakes and
injected instructions, not against a hostile agent. Running the hub as its own
OS user is the real boundary.

## 7. Clean up Discord

Only if the person asked, and only after the import finished with no gaps.

```bash
vocorum discord purge <guild id> --kimaki --json
```

This writes a plan and changes nothing. By default it covers their messages and
their bot's older than 7 days (`--older-than`, `--authors me,bot`). Threads in
use are left whole. `--threads` also deletes threads nobody else wrote in.
`--kimaki-keep` keeps threads with scheduled Kimaki work.

Show the person the summary, including what is not touched and why. Get a clear
yes. Then:

```bash
vocorum discord purge --execute <plan id> --kimaki --detach --json
vocorum discord status --json
vocorum discord report --json
```

- It only deletes what the hub already holds, with its files. There is no
  override. Never delete Discord messages any other way.
- It deletes messages with secrets first.
- Expect a few hundred deletions a minute. Large servers take a day or more.
- Give the person `~/.vocorum/purge/PURGE-REPORT.md`. It lists failures, secrets
  to change, what Discord still keeps, and the last steps they do by hand.
- Tell them to change every secret ever posted on Discord, and to reset their
  Discord bot tokens once they stop using Discord.

## Failures

| What you see | Cause | Fix |
|---|---|---|
| A device never appears in `devices list` | It never reached the hub | Check its VPN. From another device: `curl -m5 http://<hub IP>:47080/` |
| Safari says the connection is not private | Certificate not fully trusted | iPhone: Certificate Trust Settings. Mac: Keychain Access, Vocorum CA, Always Trust |
| The app name is not found on a device | Device opened a name it cannot resolve | Start at the setup link by IP, then use its app link |
| `doctor` warns the hub is slow | A long job is running, usually an import | Wait, check `discord status` |
| Imported messages from others are empty | Message Content intent was off | Turn it on, run the import again |
| Your old messages show under a Discord name | `ownerDiscordIds` not set | `config set ownerDiscordIds`, run the import again |
| `Location not found` from Kimaki | A project folder moved | `kimaki project add <new path>` |
| `Free usage limit reached` | New Kimaki data folder on a free model | Set the model with `/model` |
| Kimaki unit ends as failed on stop | No `KillMode=mixed` | Add it |
| Bots on other machines cannot load files | No public URL | `vocorum config set publicUrl https://<hub name>:47443`, then `vocorum restart` |
| 421 Misdirected Request | The host name is not one of the hub's | Use a name from `vocorum private status` |
| A purge plan skips messages | Their files are not in the hub yet | Run the import again, then plan again |
| An approved request was wrong | | `vocorum requests undo <id>`; the owner approves the undo |

Lessons from real setups:

- Import before you purge. Files deleted on Discord before the import are gone.
- Keep the hub answering: check `doctor` during long jobs.
- When several agents edit the same repo, stage changes by hunk, not by file.
