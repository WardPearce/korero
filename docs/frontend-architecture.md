# Korero.chat client

The SvelteKit client builds to `frontend/dist`. Electron packages those assets for
desktop. Capacitor copies the same build into the Android and iOS projects.
The client connects to a separately deployed Bun/Elysia and mediasoup server
using the [v1 protocol](protocol.md).

The [TypeScript SDK](../sdk/) provides the HTTP client, identity and direct-message
cryptography, and browser and mobile sessions. The Svelte client subscribes to SDK
state events and retains the platform adapters for Android transport, audio, and
the Electron bridge.

## Server connections

At launch the client signs in to every saved server and keeps those sessions
open. The rail selects which server the workspace shows. Background servers
still deliver direct messages, pokes and unread counts. A server that needs a
certificate decision, server password or enrollment waits until you select it
and finish the connect dialog. Voice uses one channel at a time. Joining a
channel leaves any channel on another server, and push-to-talk follows the
server you are talking on.

Right-click a message to edit or delete it. Senders can edit their own messages, and
a member with `deleteChannels` in the channel can delete another member's message.
Direct messages follow the same rules for their sender. The client shows the
`editedAt` marker after an edit is accepted.

Search a channel from the search button in its header. The server searches the
channel's stored messages, and **Jump** opens the surrounding messages.

The client keeps every direct message it decrypts in a separate IndexedDB database,
`korero-direct-messages`, on the device. This covers live delivery, the offline queue
and server history, including messages from background servers. Conversations show
archived messages after the server's retention ends or on servers without persistence.
The search field on the direct messages page searches this archive. The archive holds
plaintext and is protected only by the device's own storage protection. Removing a
server deletes its archive, and signing out of a hosted account deletes the archive of
that identity. A packet that fails signature verification is shown as an error and is
never archived. A message deleted while this device was offline stays in its archive.

## Electron desktop

Electron serves the local app from a secure custom origin with a sandboxed
renderer. The preload exposes the client operations and state events used by
Svelte. The Electron main process verifies HTTPS and WebSocket connections,
signs identity challenges, and keeps session credentials in memory. It relays
media signaling for the renderer, which uses `mediasoup-client` for voice, camera
and screen sharing. Electron supplies microphone and camera permissions and the
screen or window picker.

Install Bun 1.4.5 and Node.js 22.12 or newer.
If you previously selected individual audio devices, choose them again in Audio
settings. The renderer uses Chromium device IDs and falls back to system defaults
when a saved device is unavailable.

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

`bun run electron:pack` builds Linux x86-64 AppImage, Debian, RPM, Snap, and ZIP
packages in `frontend/desktop-dist`. On Fedora install `libxcrypt-compat` for
Electron Builder's bundled FPM and `rpm-build` for `rpmbuild`.

System-wide talk shortcuts use X11. The focused-window shortcuts also work in
Wayland sessions.

When connecting to a server with a private certificate, verify the displayed
certificate SHA-256 fingerprint with the operator before approving it. See
[server identity](server-identity.md) for details.

## Capacitor mobile

The Android and iOS apps use the system WebView for chat, voice, and camera
sharing. Join a voice channel with the app open. An active call can continue
when you switch apps or lock the screen. Android runs a foreground service for
the call, and iOS uses the system background audio mode. Leaving the channel or
disconnecting ends background audio.
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
in `backend/`. The frontend SDK test exercises the built app against a temporary
server. The audio checks exercise signaling and media with synthetic input. Run
the Electron checks from a graphical desktop session.

```sh
cd frontend
bun run build
cd ../backend
bunx --bun playwright install chromium
bun run test:e2e:frontend
bun run test:e2e
bun run test:e2e:desktop
```

Pass `--desktop` to `bun run test:e2e:frontend` to include the Electron SDK flow.
