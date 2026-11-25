# When a slash command seems to disappear

The slash suggestion selects a command. Enter on the command line submits it. A bot can acknowledge immediately with a result, open a modal, or acknowledge first and send the actual result later. A deferred acknowledgement is not a visible reply.

The hub writes local `[interaction]` journal entries. Find the reference shown with a delayed response, for example `journalctl --user -u vocorum --grep='INTERACTION_ID'`. The entries contain the command name, IDs, response type, elapsed milliseconds and recipient count. They do not contain arguments, tokens or reply text. No external telemetry is sent.

* No **dispatched** entry: check the selected command line and the device connection.
* **no-ack**: the hub dispatched the interaction, but did not observe a callback within three seconds. Check that the serving bot is connected to the right guild.
* **acknowledged** with type 5: the bot accepted the command. Look for **published** with the same interaction ID. If it never appears, inspect the bot's execution of that command.
* **published**: the first visible message was sent. **edited** updates an existing message. A late or private reply can be recovered with **Check for reply**, without executing the command again. A zero recipient count means no eligible device socket received the event; a positive count is a socket send, not proof a browser painted it.
