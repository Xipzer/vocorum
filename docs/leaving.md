# Leaving Vocorum

Your messages are yours. Before you remove the hub, take them with you as plain
files that need nothing from Vocorum to read.

## 1. Export

```
vocorum export ~/my-vocorum-export
```

You get one folder, which must be outside the hub's own folder. It says how many messages, channels, threads and files it wrote. Start with `README.txt`.

| In the folder | What it is |
|---|---|
| `servers/<server>/<category>/<channel>.md` | Each channel, to read, oldest first (no category folder when it has none) |
| `servers/.../<channel>.jsonl` | The same messages, one JSON object per line, for scripts and other apps |
| `servers/.../<channel> threads/` | Each channel's threads, the same way |
| `direct messages/` | Your own direct messages (never other people's); only there if you have any |
| `files/<message id>/<file name>` | Every stored file, linked from the messages |
| `people.json` | Who each id is |

If you may come back, or move to another computer, also take a backup. A backup can be restored, an export cannot:

```
vocorum backup ~/my-vocorum-backup
```

## 2. Uninstall

```
vocorum uninstall
```

This only lists what it would do:
- stop and remove the hub's service, and the services of its Kimaki and admin agent;
- stop anything running in the background;
- remove the `vocorum` command that setup made.

When the list looks right:

```
vocorum uninstall --yes
```

Your data stays in the hub folder (`~/.vocorum`) unless you also pass `--delete-data`. Only do that after the export or backup above is somewhere safe. Backups you keep elsewhere hold the hub's keys: delete them too once you no longer need them.

## 3. By hand

`vocorum uninstall` reminds you of these at the end:
- **On each phone and computer, remove the hub's certificate:**
  - iPhone and iPad: Settings, General, VPN & Device Management.
  - Mac: Keychain Access, System.
  - Android: Settings, Security, Encryption & credentials, User credentials.
  - Windows: certmgr.msc, Trusted Root Certification Authorities.
- **Delete the hub's passkey** in your password manager.
- **Uninstall the Vocorum app** where you installed it.
- **Tailscale:** revoke any computer shares you made for friends.
- **The code:** delete the vocorum folder you cloned.

Friends you invited keep nothing on your hub once it is gone. Their own devices still hold the certificate and passkey; tell them they can remove both the same way.
