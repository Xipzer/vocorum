# Move from Discord

This brings your bots and your history from a Discord server into Vocorum. Your
Discord server keeps working until you decide to clean it up.

Do the [install](install.md) first.

## 1. Point your bots at Vocorum

Each machine gets its own bot token.

**Kimaki on the hub machine:** one command makes its token and sets it up as a
service, with its own data folder so it does not mix with a Kimaki that still
talks to Discord:

```bash
node bin/vocorum.js kimaki setup <machine>
```

Then pick your usual model with `/model` in the app.

**Any other bot or machine:** make a token on the hub:

```bash
node bin/vocorum.js bots add <machine> --out ~/.vocorum/<machine>.env
```

The file holds the token. It is shown once and only you can read the file.

**Other discord.js bots:** log in with the token from the file and set the REST
address to the hub:

```js
new Client({ intents, rest: { api: 'http://127.0.0.1:47100/api' } })
```

**A bot on another machine:** copy its `.env` file and `~/.vocorum/ca/ca.crt` to
that machine over SSH, then start the bot with
`NODE_EXTRA_CA_CERTS=/path/to/ca.crt`. Never paste the token into a chat.

Check: the bot's category and channels appear in the app, and a message in a
project channel gets an answer.

## 2. Bring your history over

The import reads your Discord servers with your bot's token and copies
messages, threads, files, avatars and icons into the hub. It keeps Discord's
ids, so links and threads line up.

First tell the hub which Discord account is yours, so your old messages show as
you. In Discord: Settings, Advanced, turn on Developer Mode, then right click
your name and Copy User ID.

```bash
node bin/vocorum.js config set ownerDiscordIds <your Discord user id>
vocorum restart
vocorum backup
vocorum discord scan all --kimaki
```

`scan` changes nothing. It shows each server, what the bot cannot read, and how
long the import will take. `--kimaki` uses the token of the Kimaki on this
machine. Otherwise use `--token-file <file>` with a bot token in it.

The bot needs the **Message Content** intent, or other people's messages come
over empty. Turn it on in the Discord developer portal: your app, Bot,
Privileged Gateway Intents.

```bash
node bin/vocorum.js discord import all --kimaki --detach
node bin/vocorum.js discord status
```

- It runs in the background. You can close the terminal.
- It can be stopped and started again.
- It copies files while Discord still serves them. Do it soon: Discord only
  keeps old files for a limited time.
- It marks old messages as read.
- If it finds passwords or keys in your messages, it lists them (masked) in
  `~/.vocorum/import/report.json`. Change them.

Check: open a few old threads in the app. Pictures load, and nothing shows as
unread.

Moving a community with other members? See
[Moving a Discord community](communities.md) for what comes across and how
members join.

## 3. Clean up Discord (optional)

Only do this once the import has finished and you have looked at the result.

```bash
node bin/vocorum.js discord purge <server id> --kimaki
```

This changes nothing. It writes a plan of what it would delete, and prints its
id and a summary. By default it plans your messages and your bot's that are
older than 7 days. Threads still in use are left alone. Messages from other bots
and webhooks are left too: the plan names them and shows how to include them.
Add `--channels <id,id>` to try it on a few channels first. To empty a channel
completely, other people's messages included:
`--channels <id> --older-than 0d --authors all --threads`. The empty channel
stays on Discord until you delete it there.

When you are happy with the plan:

```bash
node bin/vocorum.js discord purge --execute <plan id> --kimaki --detach
node bin/vocorum.js discord status
node bin/vocorum.js discord report
```

- A message is only deleted from Discord once the hub holds it and its files.
  There is no way to turn this off.
- It never deletes other people's messages.
- Discord limits how fast messages can be deleted: large servers take hours or
  days. It can be stopped and started again.
- `report` writes `~/.vocorum/purge/PURGE-REPORT.md`: what was deleted, what
  failed, and what Discord still keeps.
- Deleting does not undo exposure. Change any password, key or token that was
  ever posted on Discord.

When you stop using Discord, also reset your bot tokens in the Discord developer
portal. The report lists the last steps you can only do by hand.

## Big servers

A server with 400,000 messages imports in about half an hour, mostly waiting on
Discord, and the hub stays usable while it runs. To clean up, add `--threads`
to the purge: an agent thread nobody else wrote in is deleted in one request,
so 400,000 messages take about an hour and a quarter instead of about 11 hours.
A thread is only deleted whole when everything in it is already on the hub.

## What does not come over

- Files Discord no longer has.
- Direct messages, voice channels and Discord's audit log.
- Reactions from other people may be incomplete.
