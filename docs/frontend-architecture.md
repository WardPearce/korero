# VNX.chat client

The SvelteKit client builds to `frontend/dist`. Electron packages those assets for
Linux x86_64. Capacitor copies the same build into the Android and iOS projects.
The client connects to a separately deployed Bun/Elysia and mediasoup server
using the [v1 protocol](protocol.md).

## Electron desktop

Electron serves the local app from a secure custom origin with a sandboxed
renderer. The preload exposes the client operations and state events used by
Svelte. A separate Rust process handles the verified HTTPS and WebSocket
connections, signs identity challenges, and keeps the session credentials in
memory. The same process uses libmediasoupclient and libwebrtc for voice.
Electron supplies the camera and the screen or window picker.

Install Bun 1.4.5, Node.js 22.12 or newer, Rust 1.95 or newer, Clang with its resource
headers, CMake, Ninja, Git, curl, pkg-config, and the X11 development headers.
First-time desktop builds prepare the pinned WebRTC SDK in
`frontend/.native/m140-linux-x86_64`. Set `CXX` to select another Clang or
`KORERO_MEDIA_SDK` to use a prepared SDK.

From the repository root, start the server in one terminal.

```sh
cd backend
bun install --frozen-lockfile --ignore-scripts
bun run prepare:worker
bun run start
```

Launch the desktop client in a second terminal.

```sh
cd frontend
bun install --frozen-lockfile
bun run electron:dev
```

`bun run electron:pack` builds an AppImage and a Debian package in
`frontend/desktop-dist`. On Fedora the bundled Debian packaging tool needs
`libxcrypt-compat`. System-wide talk shortcuts use X11. The focused-window
shortcuts also work in Wayland sessions.

When connecting to a server with a private certificate, verify the displayed
certificate SHA-256 fingerprint with the operator before approving it. See
[server identity](server-identity.md) for details.

## Capacitor mobile

The Android and iOS apps use the system WebView for chat, voice, and camera
sharing. Voice uses the microphone while the app is in the foreground.
Audio device selection and processing controls, whisper transmission, and
system-wide shortcuts are desktop features. Screen capture depends on the
system WebView.

The mobile WebView requires an HTTPS certificate trusted by the device.
Configure a trusted certificate for your server or reverse proxy and explicitly
allow the app origins in the server configuration.

```toml
[server]
origins = ["https://localhost", "capacitor://localhost"]
```

Append these values to any origins already configured. The first is used by
Android and the second by iOS.

From `frontend/`, run the following after changing the client.

```sh
bun install --frozen-lockfile
bun run mobile:sync
```

- Android uses JDK 21 and Android SDK 36. Run `bun run mobile:android` to open
  Android Studio, or run `cd android && ./gradlew assembleDebug` to build the
  APK at `android/app/build/outputs/apk/debug/app-debug.apk`. [Capacitor Android](https://capacitorjs.com/docs/android)
- iOS uses macOS and Xcode 26 or newer. Run `bun run mobile:ios` to open the
  Xcode project, then select a team and a device or simulator. [Capacitor iOS](https://capacitorjs.com/docs/ios)

## Move an existing identity

Before switching clients, export an encrypted backup from **Settings → Identity**
in the previous installation. Import that backup in Electron or Capacitor to use
the same server accounts. Add saved servers and configure local preferences in
the new installation.

## Verify

Run `bun run check` in `frontend/` and run `bun run check` and `bun run test`
in `backend/`. The existing native audio probe and browser audio checks exercise
signaling and media with a synthetic input.

```sh
cd frontend
bun run prepare:media --if-needed
cargo build --locked --manifest-path native/Cargo.toml --features media --bin voice-probe
cd ../backend
bunx --bun playwright install chromium
bun run test:e2e
bun run test:e2e:native
```
