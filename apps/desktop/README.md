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
vocorum pair laptop --app
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

The Windows installer can also be built on Linux with
[cargo-xwin](https://github.com/rust-cross/cargo-xwin) (it fetches Microsoft's
CRT and SDK, under Microsoft's licence), clang, lld and NSIS:

```bash
XWIN_ACCEPT_LICENSE=1 cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

## Known limits

- **iPhone alerts:** iOS suspends an app's connection soon after it leaves the
  screen, and the hub holds alerts while any of your windows is in front, so
  the iPhone app alone shows none yet. Use the PWA's Web Push on the phone
  until the hub can send through Apple's push service.
- **Approvals on Linux:** there is no OS check before a key is used, so Linux
  apps approve with a passkey in a browser.
- **Unsigned installers:** releases are not code signed by a public
  certificate authority. Before you run one, check that its SHA-256 matches
  the one on your hub's setup page. If Windows stops it, choose More info,
  then Run anyway. If macOS blocks it, open System Settings > Privacy &
  Security and choose Open Anyway. Updates after that don't ask, and every
  update is checked against the publisher key.
- **Linux updates:** the AppImage updates itself in place. The `.deb` updates
  too, but asks for your password, because installing a package needs root.

## Releases

`apps/desktop/scripts/release.sh linux|windows|macos [out-dir]` builds the
installers and writes `SHA256SUMS`. Builds are repeatable: the Rust version is
pinned in `src-tauri/rust-toolchain.toml`, dependencies come from the lock
files, `SOURCE_DATE_EPOCH` comes from the commit and build paths are remapped
out of the binary. Two clean Linux builds of the same commit give the same
binary, byte for byte.

With `VOCORUM_UPDATER_PUBKEY` set the app accepts updates signed by that key;
with `TAURI_SIGNING_PRIVATE_KEY` as well, the build also writes the `.sig`
files. Publish a release on your hub with `vocorum apps publish <dir>`: paired
apps then update from the hub itself, and the hub's setup page offers the
installers to devices holding a valid pairing code. Nothing is fetched from
any other host.

## End-to-end tests

`tests/apps-e2e/run.ts` checks a release build against a throwaway hub:
pairing, sending, receiving, a native notification, memory budgets, and with
`--from` an update from an older release to this one.

```sh
node --import tsx tests/apps-e2e/run.ts --platform linux --release <dir> [--from <older AppImage>]
node --import tsx tests/apps-e2e/run.ts --platform windows --release <dir> [--from <older installer>]
```

Linux drives the app with `tauri-driver` and `WebKitWebDriver`
(`webkit2gtk-driver`), in its own D-Bus session. Windows runs from WSL with
node installed on Windows: it installs the build, opens WebView2's debugging
port on localhost only, and reads notifications back from Windows. It refuses
to run over an installed Vocorum. Every run keeps its data in its own folder
(`VOCORUM_DATA_DIR`), so it never touches your own app.

## Per system notes

- **Windows (WebView2):** Chromium based, so it behaves like Chrome.
- **macOS and iPhone (WebKit):** behaves like Safari. The microphone needs the
  usage text in `Info.plist`, which is included.
- **Linux (WebKitGTK):** the most fragile engine. The app turns on WebKitGTK's
  media stream setting so voice notes work. It also turns off WebKitGTK's GPU
  compositing, which falls back to software GL on many machines and then costs
  whole cores per animation (`VOCORUM_GPU=1` turns it back on), and looping
  animations step at a few frames a second. Without a Secret Service (for
  example on WSL or a bare window manager) the device key falls back to a 0600
  file in the app's config folder.
