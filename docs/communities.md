# Moving a Discord community

The same `vocorum discord` commands that move your own servers also move a
community: its roles and permissions, its members and who holds which role,
categories, forums, private threads, pins, reactions and custom emoji.

## Before you start

1. **A bot in the server.** Create a bot in the Discord developer portal and add it to the server with the Administrator permission (or at least View Channels and Read Message History everywhere).
2. **Turn on two intents** in the portal, under your app, Bot, Privileged Gateway Intents:
   - **Message Content.** Without it, other people's messages arrive empty.
   - **Server Members.** Without it there is no member list. Only people who wrote messages come across, and without their roles. Nobody but admins can see private threads either.
3. **Say which Discord account is yours,** so your messages show as you:
   ```
   vocorum config set ownerDiscordIds <your Discord user id>
   vocorum restart
   ```

## See what will come across

```
vocorum discord scan <server id> --token-file ~/discord-token
```

This changes nothing. For each server it shows:
- its channels and threads;
- what comes across: roles, the member list, channel permissions, custom emoji, forums, private threads;
- what stays on Discord: voice and stage channels;
- a PROBLEM line for each missing intent.

## Import

```
vocorum discord import <server id> --token-file ~/discord-token --detach
```

It runs in the background and resumes if stopped. Follow it with `vocorum discord status`. At the end it lists what did not come across.

To try it on a few channels first, add `--channels <id>,<id>`. Roles and members still come across whole; the "not imported" list describes the whole server.

| From Discord | On the hub |
|---|---|
| Categories, text and announcement channels | The same, in the same order |
| Forums | A forum whose posts are threads. Tags are not kept |
| Roles: name, colour, order, shown separately, mentionable | The same, with the same ids |
| Role and channel permissions | The same. The hub enforces viewing, sending, threads, files, reactions, pins, managing messages, channels, roles and the server, and Administrator |
| Members, their roles and nicknames | People on the hub, who cannot sign in until you invite them |
| Private threads | Only their members see them, plus anyone whose role has Administrator or Manage Threads |
| Pins, replies, edits, embeds, files | The same |
| Reactions | The same, with who reacted |
| Custom emoji | Stored on the hub, so they keep working after you leave Discord |

**Not imported** (the import's report says which of these your server has):
- voice and stage channels, and any text chat in them;
- forum tags;
- slow mode and the age-restricted mark;
- role icons;
- current timeouts;
- custom stickers (a message with a sticker shows the sticker's name);
- scheduled events;
- bans, invites, the audit log, AutoMod rules, onboarding questions and integrations.

Some permissions are kept but nothing uses them yet: kick and ban, timeouts, nicknames, webhooks, emoji management, events and the audit log.

## Bring people in

Members come across as people without a way to sign in. `vocorum people list` shows them.

Before inviting anyone, check the import's list of administrators. Anyone with Administrator on Discord is an administrator on the hub once they join.

For each person who should join, run:

```
vocorum welcome <their Discord username>
```

This prints a message with a one-time code, valid for 24 hours, to send them. They open it, pair a device, and land in the server with their Discord roles.

Do not use `vocorum invite` for them: it makes a new, separate account without their roles or history. Your own Discord account is already you on the hub; to add your own device, use `vocorum pair`.

## Importing again

You can import again while people still use Discord: it adds new messages, roles, members and channels.

Anything already imported keeps what the hub says. If you took a role away from someone, renamed a role or changed a channel's permissions on the hub, the next import leaves it as you set it. The import says how many things it left alone.

## Then

When everyone has moved, `vocorum discord purge` can clear the messages off Discord (see the migration guide). It only deletes what the hub holds. By default it only deletes your own and bots' messages.
