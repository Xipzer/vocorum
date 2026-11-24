# Vocorum apps

The desktop apps (Windows, macOS, Linux) and the iPhone app. They are one small
Rust program built with [Tauri 2](https://tauri.app) around the same web UI the
hub serves, so every screen looks the same as in the browser.

## How it works

- **The UI is built into the app.** Nothing is loaded from the network to run
  it. The page lives on the app's own origin (`hub://localhost`, or
  `https://hub.localhost` on Windows) under a strict Content Security Policy:
  scripts only from the app, no frames, no service worker, and no navigation
  to any other origin. Web links open in your browser; files from the hub are
  saved to Downloads.
- **Rust talks to the hub, the page never does.** Requests to `/client/*` and
  `/attachments/*` are passed to the hub by the app, which drops cookies and
  adds its own token. The page holds no credential.
- **TLS trusts only your hub's CA.** The pairing link carries the CA's SHA-256.
  The app fetches the CA from the hub's enrolment port, checks the hash, then
  trusts that CA and nothing else. The hub's name resolves to the address in the
  link, so no DNS profile, hosts file or certificate profile is needed on any
  device.
- **A device key instead of a passkey.** Passkeys do not work inside app
  webviews. At pairing the app makes an Ed25519 key, keeps the private half in
  the OS keychain (Keychain on macOS and iPhone, Credential Manager on Windows,
  the Secret Service on Linux) and gives the hub the public half. To sign in it
  signs the hub's challenge and gets a 12 hour token, kept in memory only. No
  cookies means no CSRF.
- **Alerts come over the app's own connection.** The app holds the hub's event
  socket in Rust, so it keeps working with the window closed. Closing the window
  frees it entirely; only the tray icon and that connection stay (a few MB).
  The hub sends `NOTIFY` events under the same rules as Web Push, and the app
  shows them as system notifications.
- **Native bits:** system notifications, the microphone for voice notes (asked
  for only while recording), the system file picker, a tray icon, and an
  optional "Start when I log in" in the tray menu.

## Pairing

On the hub machine:

```bash
vocorum devices add laptop
```

It prints a `vocorum://pair?...` link and a QR code. Open the link on the device
(or paste it into the app's sign in card, or scan the QR with the iPhone camera)
and choose **Pair this device**. The app never pairs without that click.

## Building

The app needs the web UI built into `apps/desktop/dist` first:

```bash
pnpm build:app-web
```

Then, in `apps/desktop/src-tauri`, with Rust and the Tauri CLI (`cargo install tauri-cli --locked`):

```bash
cargo tauri build            # this machine's installers
cargo tauri ios build        # iPhone, on a Mac with Xcode
```

What each system needs:

- **Linux:** `pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`.
  Builds a `.deb` and an AppImage.
- **Windows:** the Visual Studio C++ Build Tools. Builds a per-user installer
  (no admin needed). WebView2 ships with Windows 10 and 11.
- **macOS and iPhone:** Xcode. Builds a `.app` and a `.dmg`, and the iPhone app.

## Per system notes

- **Windows (WebView2):** Chromium based, so it behaves like Chrome.
- **macOS and iPhone (WebKit):** behaves like Safari. The microphone needs the
  usage text in `Info.plist`, which is included.
- **Linux (WebKitGTK):** the most fragile engine. The app turns on WebKitGTK's
  media stream setting so voice notes work. Without a Secret Service (for
  example on WSL or a bare window manager) the device key falls back to a 0600
  file in the app's config folder.
