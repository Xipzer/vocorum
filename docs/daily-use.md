# Daily use

Vocorum works like Discord. This page covers what is different, and the
commands you will use on the hub.

## Overview

The Overview shows each machine and its sessions. **Needs you** lists sessions
waiting for an answer, such as a question with buttons. Tap one to answer it.

## Sessions and channels

- Each machine's bot gets its own category, with a channel per project.
- Write in a project channel to start a session. The bot answers in a thread.
- Older threads fold into "older" under their channel.
- Type `/` to see the bot's commands.
- Hold the microphone to send a voice note.

## Notifications

- By default you are only notified when mentioned, or when a session needs you.
- Change it per server, category, channel or thread: all messages, mentions only,
  or nothing.
- Phones only get notifications from the app on the home screen. Turn them on in
  the app's settings.
- Nothing is sent while the app is open on any of your devices.

## Ask your admin agent

If you use Kimaki, `vocorum admin setup` gives you a private Admin server with
one channel, #admin. Write there in plain words, for example "is everything
ok?", "invite sam" or "undo that", and your own agent runs the hub for you.

- Checks and lists run straight away.
- Any change shows you the command first, to accept or deny.
- Anything that gives someone more access waits in your Inbox for your passkey.

Only you and the admin bot are in that server, and the agent can only run
`vocorum` commands, so other people's messages cannot steer it.
`vocorum admin status` checks those guard rails.

## Devices

In the app, Settings, Devices lists every signed-in device. Rename one, sign it
out, or pair a new one from there. On the hub:

```bash
node bin/vocorum.js devices add <name>       # pairing code, 10 minutes
node bin/vocorum.js devices list
node bin/vocorum.js devices revoke <name>
```

## Machines and bots

Each machine gets its own bot token. You can sign one machine out without
touching the others.

```bash
node bin/vocorum.js bots add <machine> --out ~/.vocorum/<machine>.env
node bin/vocorum.js bots list
node bin/vocorum.js bots revoke <machine>
node bin/vocorum.js machines icon <machine> avatar picture.png
```

## Servers

Keep projects apart the way you would with several Discord servers.

```bash
node bin/vocorum.js guilds add 'Side Projects'
node bin/vocorum.js bots guilds <machine> 'Home,Side Projects'
node bin/vocorum.js guilds list
```

## Invite a friend

On the hub:

```bash
vocorum invite sam --name "Sam"
```

- Sam gets the Friends server. Your machines and agent sessions stay in Home,
  which Sam cannot see. Use `--server` to pick another server.
- It prints a message to send Sam, and your part: share this computer with Sam
  in Tailscale (admin console, the machine's menu, Share).
- You never need Sam's Tailscale email. The hub learns Sam's account when they
  pair, and after that only that account works for Sam.
- `vocorum welcome sam` makes a fresh link, for a new device or an expired code.
- `vocorum access sam` shows exactly what Sam can see and do.
- `vocorum people remove sam` signs out all of Sam's devices. Then remove the
  share in Tailscale.

Without Tailscale, Sam has to reach your private network some other way, such
as WireGuard. Vocorum is never put on the internet.

> Anyone who can talk to an agent bot can run commands on that machine. Kimaki
> answers admins and people with the `kimaki` role. Only you can give that role.

## Disk space

Search adds about 150 MB to `hub.db` for every 400,000 messages, and a search
answers in about 20 ms.

## Backups

`vocorum backup` makes a full copy while the hub runs. See
[Back up and recover](recovery.md) for keeping it safe and bringing the hub
back, and [Leaving Vocorum](leaving.md) to export your messages.
