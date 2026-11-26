A self-hosted, voice-first server with direct-IP HTTPS and WebSocket signalling, a WebRTC SFU,
public-key accounts, persistent device sessions, hierarchical channels, moderation, and chat.
The [v1 protocol](docs/protocol.md) is open to independent clients. The Bun/Elysia server lives in
[`backend/`](backend/). The SvelteKit and Tauri desktop client lives in [`frontend/`](frontend/).

## Develop the desktop client

Prepare the native media SDK and launch Tauri on Linux x86_64. See the
[client build guide](docs/frontend-architecture.md) for prerequisites, certificate setup,
and the native audio test.

## Manage a server

Right-click a connected server and choose **Server administration**. Use
**Overview** to set the message of the day, the default role for new accounts,
and the default Opus bitrate for voice channels. Use **Roles** to manage custom
roles and assign them to accounts. **Audit log** shows account activity,
connections, voice channel joins and leaves, moderation, and server changes.
Filter by event type or actor account ID.

The first owner claims the server with its setup token. Regular sign-in uses
your VNX.chat identity and follows the server’s registration policy. Right-click
a channel to change its password or bitrate. Leave the channel bitrate blank to
inherit the server default.

Start the server with `--config ./server.toml` from `backend/` to use that
file. Host-side TOML changes apply after a restart. Environment overrides take
precedence.

To use administration in a browser, serve the frontend over HTTPS or localhost,
add the frontend’s origin to `server.origins`, and use a server certificate
trusted by the browser. You can import an existing VNX.chat identity backup.

See the [TeamSpeak 6 and Discord comparison](docs/server-feature-research.md)
for possible additions to server administration and voice.

## Share and chat

Join a channel to format messages with the rich-text composer, pick emoji,
and attach a file. The default
limit is 4 MiB per file. Admins can set a limit from 1 to 32 MiB in
**Server settings → Overview**.
Attachments follow message retention when persistence is enabled. With persistence
disabled, the server keeps attachments in memory for up to one hour.

Open **Direct messages** from the channel sidebar or a member’s menu. Before
you can read or send messages in a conversation on this device, compare safety
codes with your contact in person or over a trusted channel. Both accounts use
the same server. The server relays encrypted messages and holds them for offline
delivery only when message persistence is enabled.

Choose **Share screen**, set resolution, frame rate, video bitrate and optional source
audio, then choose a window, browser tab or full display in the system picker.
The preview stays local until you choose **Go live**. Available sources and source
audio depend on your browser and operating system. On Linux, the desktop webview
uses WebKitGTK and the desktop screen-sharing portal. Microphone voice uses the
desktop app.

Choose **Turn on camera** in your current channel. Set resolution, frame rate
and bitrate, then preview the camera and choose **Start camera**. Other channel
members can select your camera to watch it. Camera and screen video can run at
the same time. Your camera preview uses no microphone audio.

In **Settings → Audio → Transmission**, choose **Push-to-talk** or
**Toggle-to-talk** and record a shortcut. Hold it for push-to-talk. Press it
once to start and again to stop for toggle-to-talk. Enable **System-wide talk
shortcut** to use it while other apps are focused on supported desktops.
Linux Wayland sessions use the focused-window shortcut.

Use **Whisper to another channel** in the voice toolbar to select an occupied
channel you can speak in. Choose push-to-talk or toggle-to-talk and record a
separate shortcut. The default is **Alt+B** while VNX.chat is focused. Whisper
audio goes only to the selected channel while you stay in your current room.

## Run a standalone build

On a supported Linux machine, verify the release's SHA-256 checksums and run the binary for your architecture.

```sh
sha256sum --ignore-missing -c SHA256SUMS
chmod +x voice-server-linux-amd64
./voice-server-linux-amd64
```

The server creates its data directory, Lobby, TLS identity, and a first-owner setup token.
Share the signalling IP and port (for example, `192.168.1.100:8443` or `[2001:db8::1]:8443`)
and the TLS public-key fingerprint over a trusted channel. A compatible client verifies the
fingerprint before sending credentials and uses `POST /api/v1/admin/bootstrap` to create the
first owner. Forward TCP 8443 and UDP/TCP 8444 where the network requires it.

The verified host and system requirements are recorded in [Compatibility](docs/compatibility.md).
The executable embeds Bun and extracts a checked native worker. Both run without a separately
installed language runtime. Linux requires glibc, libstdc++, and OpenSSL 3.5.9 or newer shared libraries.

## Run with Docker

Set the announced address to the host IP that clients can reach.

```sh
VOICE_MEDIA_ANNOUNCED_ADDRESS=192.168.1.100 docker compose up -d --build
docker compose logs voice-server
```

The named volume preserves database and TLS identity. The container runs as UID 10001 and
publishes signalling and media ports separately. See [Deployment](docs/deployment.md) for
LAN, IPv6, VPN, NAT, and backup instructions.

## Develop and verify

Use Bun 1.4.5 and a Linux native build toolchain. On Debian 13 the worker build dependencies are
`build-essential ca-certificates libssl-dev meson ninja-build pkg-config`.

```sh
cd backend
bun install --frozen-lockfile --ignore-scripts
bun run prepare:worker
bun run check
bun run test
bunx --bun playwright install chromium
bun run test:compatibility
bun run test:e2e
bun run build
bun run test:e2e dist/voice-server-linux-amd64
bun run start
```

Build the AMD64 and ARM64 artifacts on matching hosts. Use `bun run db:generate --name=NAME`
to generate a Drizzle migration after updating the checked-in schema. Server startup applies
migrations from the project or from the compiled executable.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Authentication](docs/authentication.md)
- [Server identity and native client integration](docs/server-identity.md)
- [Deployment and backups](docs/deployment.md)
- [Security](docs/security.md)
- [Compatibility and measurements](docs/compatibility.md)
- [Client architecture and build](docs/frontend-architecture.md)
- [Server third-party notices](backend/THIRD_PARTY_NOTICES.md)
