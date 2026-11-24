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

## People

You can invite others. They only see the channels their roles allow.

```bash
node bin/vocorum.js people invite <username> --guild Home    # code valid 24 hours
node bin/vocorum.js people list
node bin/vocorum.js people remove <username>
```

> Anyone who can talk to an agent bot can run commands on that machine. Kimaki
> answers admins and people with the `kimaki` role. Only you can give that role.

## Backups

Everything is in `~/.vocorum`. Stop the hub and copy the folder, or back up
`twin.db`, `hub.db` and `attachments/` with your usual tool. The folder holds
keys: keep the copy private.
