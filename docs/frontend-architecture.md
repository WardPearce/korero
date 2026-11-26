# VNX.chat client

The client uses SvelteKit, Svelte 5, Tailwind CSS, and Bits UI. The static adapter
writes the SPA entry point and assets to `frontend/dist` for Tauri 2. The root
layout owns the server sidebar and listens for native session updates across
the workspace and account settings routes. VNX.chat connects to a separately
deployed Bun/Elysia and mediasoup server using the [v1 protocol](protocol.md).

Eden Treaty type-checks discovery and account requests
against the Elysia app. A scoped Tauri command sends those HTTP requests through
native Rust. The native identity command signs server challenges for enrollment
and sign-in. The Rust session coordinates refresh-token rotation, authenticated
WebSocket requests, heartbeat, reconnect, and channel state. It sends client
state and errors to Svelte over Tauri IPC.

A dedicated worker calls the C++ bridge to libmediasoupclient and libwebrtc.
Rust continues to handle signaling while C++ waits for transport negotiation.
Each joined room can have a send and a receive transport. The client resumes
server consumers after creating the corresponding native consumers. It closes
native audio and server transports on leave. Mute and deafen close the affected
directions and recreate resources when voice is enabled again.

The native client uses the platform certificate store for HTTPS and WSS. For a
self-signed server, export the public certificate with the server's
`identity export` command and select it in the connect dialog. Obtain and
verify the certificate through a trusted channel. Refresh credentials stay in
native memory. The saved identity signs a fresh challenge when the app reconnects
after the desktop process exits.

## Linux x86_64

Install Bun 1.4.5, Rust, Clang with its resource headers, CMake, Ninja, Git,
curl, and the Tauri 2 Linux development dependencies. On Debian or Ubuntu the
desktop dependencies include `libwebkit2gtk-4.1-dev`, `libx11-dev`,
`libxdo-dev`, `libssl-dev`, `librsvg2-dev`, and
`libayatana-appindicator3-dev`. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

From the repository root, install and start the server.

```sh
cd backend
bun install --frozen-lockfile --ignore-scripts
bun run prepare:worker
bun run start
```

From the repository root in a second terminal, prepare and launch the desktop
client.

```sh
cd frontend
bun install --frozen-lockfile
bun run tauri dev
```

The first Tauri run prepares the media SDK in `frontend/.native/m140-linux-x86_64`.
You can prepare it separately with `bun run prepare:media`. It verifies a pinned
WebRTC M140 archive from Shiguredo, builds libmediasoupclient 3.5.0 and
libsdptransform from pinned revisions, and uses Chromium's matching libc++
configuration. Cargo finds the prepared SDK in that directory by default.
Set `CXX` for a different Clang installation or `KORERO_MEDIA_SDK` to select a
different SDK directory. Build the Linux binary with the frontend embedded
using `bun run tauri build --no-bundle`.

## Verify

Use Chromium from Playwright to exercise the server. The native probe uses a
synthetic input and measures decoded PCM on the Rust client and Chromium peer.

```sh
cd frontend
bun run check
bun run build
bun run prepare:media
cargo build --manifest-path native/Cargo.toml --features media --bin voice-probe
cd ../backend
bun run check
bun run test
bunx --bun playwright install chromium
bun run test:e2e
bun run test:e2e:native
```

The native test runs two rounds with distinct WebSocket connections. In each
round both peers decode audio, then the native client leaves and its producer
closes. This build passed the native probe, the existing Chromium UDP test,
the server's 12 unit and integration tests, and
`bun run tauri build --debug --no-bundle` without an SDK environment override.
The desktop client uses the system audio device. The probe validates synthetic
capture and decoded playout. Physical microphone behavior needs a manual check.

## Android source

The Kotlin Tauri plugin requests microphone permission and starts a microphone
foreground service while the activity is visible. The service holds
communication audio focus and the native session owns the socket outside the
WebView. Leaving voice or disconnecting stops the service.

The Android APK was outside the first build. To prepare an Android build, use the
same pinned M140 WebRTC source on arm64-v8a, build libmediasoupclient for the NDK
target, and supply the corresponding Java SDK classes with
`KORERO_ANDROID_WEBRTC_CLASSES`. The Linux preparation script targets Linux only.
The Android ABI, microphone, routing, and activity recreation still need device
verification.
