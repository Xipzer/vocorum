# Back up and recover your hub

Everything your hub is fits in one folder: messages, files, people, devices,
bots, its certificate authority (CA) and its keys. Back it up, keep the copy
somewhere else, and you can bring the hub back on another computer with every
phone and laptop still signed in.

## Back up

```
vocorum backup ~/vocorum-backup-2026-11-25
```

This makes a consistent copy while the hub runs. It holds:
- both databases;
- the settings and keys;
- the CA;
- the hub's Kimaki data (its sessions and their threads);
- every stored file.

It takes about a second for a small hub. On the same disk, stored files are linked rather than copied, so they take no extra space.

A backup on the hub's own disk does not survive that disk dying. Copy it to another computer or drive:

```
tar -C ~ -cf /media/usb/vocorum-backup.tar vocorum-backup-2026-11-25
```

The backup holds the hub's keys: keep it as private as the hub itself.

## Recover on another computer

1. **Prepare the new computer.**
   - Install Node.js 22.16 or newer, git and Tailscale. On Windows, also Git for Windows, which brings openssl.
   - Get the code:
     ```
     git clone <vocorum repository> && cd vocorum
     ```
2. **Give it the old hub's network identity.** Do this before step 4. It is what keeps every device trusting the hub:
   - In the Tailscale admin console, remove the old computer.
   - Rename the new one to the old one's name.
   - Set its IPv4 address to the old one's (Machines, the computer's menu, Edit machine IPv4).
3. **Copy the backup here and restore it.** Give `restore` the full path of the unpacked folder:
   ```
   tar -C ~ -xf vocorum-backup.tar
   node bin/vocorum.js restore ~/vocorum-backup-2026-11-25
   ```
   - The hub goes into `~/.vocorum`. To use another folder, set `VOCORUM_DIR` for every command.
   - It refuses to overwrite a hub that is already there. Use `--replace` to move that hub aside.
   - It checks the copy against the backup's list of contents and says what it restored.
4. **Start it:**
   ```
   node bin/vocorum.js setup
   ```
   - It keeps the hub's address, names and CA from the backup, and shows its plan first (`--dry-run` shows only the plan).
   - It installs the service for this computer: systemd, launchd or Task Scheduler, named `vocorum` for `~/.vocorum`, or `vocorum-<folder>` for any other folder.
   - It runs `vocorum doctor`. On the hub computer itself, a warning that the hub's name does not resolve is harmless.
5. **Clean up.** The unpacked backup still holds the hub's keys. Keep it as private as the hub, or delete it once the hub runs.

That's all. Every device keeps working without anything to redo: the same address, the same certificate, its passkey and its saved sign-in. Bots and Kimaki keep their tokens.

### If the new computer cannot have the old address

Run `vocorum setup --address <its Tailscale address>` instead of step 4. The hub then makes a new CA, so on each device:
- Open the setup page (http://<new address>:47080).
- Install the new certificate.
- The passkey keeps working as long as the hub's name stays the same.

Bots on other computers also need the new address (`vocorum bots add` again, or edit their env file).

## Time it takes

Measured on a small hub (343 messages, 3 files) backed up on Linux and restored on a Mac:
- **Backup:** 0.4 s.
- **Copy to the Mac:** 0.5 s.
- **Restore and setup:** 1.1 s.

The same phone (its saved sign-in and its passkey), the bot and the certificate all worked on the restored hub.

A large hub is mostly its stored files. Copying them takes as long as your disk or network does; the rest is seconds.

## What is not in the backup

- Kimaki on Discord keeps its own data in `~/.kimaki`. Back that up separately if you use it.
- OpenCode's sessions live in OpenCode's own folders on each computer.
- Earlier backups, and logs.
