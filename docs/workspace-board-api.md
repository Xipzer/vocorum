# Workspace Board

`GET /client/threads/:id/panels` returns `{board, seen_version}`. A readable thread without a board returns two nulls. Otherwise `board` contains `thread_id`, `message_id`, the hub-attributed `machine`, and up to 20 `versions` in ascending order. Each version contains `v`, `title`, `markdown` and `updated_at` (the carrier's create or edit time in ISO UTC). Treat the markdown as data and render it without raw HTML.

`POST /client/threads/:id/panels/board/seen` accepts `{"v":2}` and returns 204. Call it when this device actually shows that version. It moves only this device's board cursor forward and does not mark chat read. An invalid version is 400; an unavailable or evicted version is 409. The stored cursor can predate the retained history. Both routes require an authenticated device with thread visibility and read-history permission.

`PANEL_UPDATE` on `/client/events` carries only `{thread_id, slot:"board", v}`. Refetch the snapshot for the relevant thread. Clearing the carrier invalidates the old version too, so do not ignore an update solely because `v` equals the displayed version. Reconnect by reading a fresh snapshot.

## Publishing

An existing registered thread bot uploads one local UTF-8 file named `board.panel.md` on a normal channel message, then edits that message and replaces the attachment. The entire file, including its header, must fit in 16 KiB:

```markdown
---
panel: board
title: Field notes
v: 1
---
## Now
The first sample is ready.
```

Use a positive integer version and a single-line title (up to 256 UTF-8 bytes). The publisher needs history, send-in-thread and attachment rights in an unlocked, unarchived thread. Machines that share a visible bot user are distinguished by their registered credentials. The first accepted carrier fixes the writer and message. Replaying its current version and redacted contents returns the existing carrier; changing the contents at the same version, or reverting to an older version, is a conflict.

The hub reads only bytes uploaded in that request. It redacts recognised secrets before retaining or serving the carrier. A board-file download is checked against the reader's current thread access. An archived board remains readable; deleting the carrier clears the board and its seen cursors.
