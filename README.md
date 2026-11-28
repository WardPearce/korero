<div align="center">
  <img src="landing/static/favicon.svg" width="120" alt="Korero.chat logo" />
  <h1>Korero.chat</h1>
  <blockquote>A self-hosted, voice-first server with an open protocol and clients for desktop, mobile and browsers.</blockquote>
  <br />

  [![License](https://img.shields.io/github/license/WardPearce/korero)](LICENSE)
  [![Latest release](https://img.shields.io/github/v/release/WardPearce/korero)](https://github.com/WardPearce/korero/releases/latest)
  [![Downloads](https://img.shields.io/github/downloads/WardPearce/korero/total)](https://github.com/WardPearce/korero/releases)
  [![Stars](https://img.shields.io/github/stars/WardPearce/korero)](https://github.com/WardPearce/korero/stargazers)
</div>

---

# Table of Contents

- [Features](#features)
- [Quick deploy](#quick-deploy)
- [Run a standalone server](#run-a-standalone-server)
- [Docker deployment](#docker-deployment)
- [Manage a server](#manage-a-server)
- [Share and chat](#share-and-chat)
- [Develop](#develop)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

# Features

- **Voice**
  - WebRTC SFU with Opus, configurable per server and per channel
  - Push-to-talk and toggle-to-talk, with optional system-wide shortcuts
  - Whisper to another channel while staying in your room
- **Video**
  - Screenshare with resolution, frame rate, bitrate and source audio options
  - Camera video alongside screenshare
- **Chat**
  - Rich-text composer, emoji and file attachments
  - End-to-end encrypted direct messages with safety codes
  - Offline delivery and optional message persistence
- **Accounts and identity**
  - Public-key (Ed25519) accounts and persistent device sessions
  - Optional hosted account with an encrypted identity and server backup
  - Link a phone by scanning a QR code
- **Server administration**
  - Hierarchical channels with passwords and bitrate overrides
  - Roles, moderation, message of the day and an audit log
  - Direct-IP HTTPS and WebSocket signalling with TLS fingerprint verification
- **Open**
  - The [v1 protocol](docs/protocol.md) is open to independent clients
  - Bun/Elysia server in [`backend/`](backend/), SvelteKit client for Electron, Capacitor and browsers in [`frontend/`](frontend/)

# Quick deploy

On a Linux host, the install script asks for the important settings from
[`server.example.toml`](backend/server.example.toml), writes the configuration and starts the
server with Docker Compose or as a systemd service running the release binary.

```sh
curl -fsSL https://raw.githubusercontent.com/WardPearce/korero/main/scripts/install.sh | sudo bash
```

Run it again to update; it offers to keep the existing configuration and never deletes data.
Pass options after `bash -s --`:

| Option | Effect |
| --- | --- |
| `--docker` / `--binary` | Choose the deploy method without asking |
| `--dry-run` | Print the files it would write, then exit |
| `--yes` | Accept every default; set `KORERO_PUBLIC_ADDRESS` and optionally `KORERO_PASSWORD` |
| `--dir PATH` | Docker project directory (default `/opt/korero`) |
| `--version TAG` | Release tag to deploy (default latest) |

For example, `curl -fsSL … | sudo bash -s -- --docker --dry-run`. Read
[the script](scripts/install.sh) before running it, or set things up by hand below.

# Run a standalone server

Verify the release's SHA-256 checksums and run the binary for your architecture on Linux.

```sh
sha256sum --ignore-missing -c SHA256SUMS
chmod +x voice-server-linux-amd64
./voice-server-linux-amd64
```

The server creates its data directory, Lobby, TLS identity and a first-owner setup token.
Share the signalling address (the port defaults to 8443, e.g. `192.168.1.100`) and the TLS public-key
fingerprint over a trusted channel. Forward TCP 8443 and UDP/TCP 8444 where needed.
See [Compatibility](docs/compatibility.md) for verified host requirements.

# Docker deployment

Set the announced address to a host IP that clients can reach.

```sh
VOICE_MEDIA_ANNOUNCED_ADDRESS=192.168.1.100 docker compose up -d --build
```

To keep the full `server.toml` in Compose, set `VOICE_CONFIG` to the TOML document itself
(it starts with a `[section]` or `#` comment) instead of mounting a file. Keep it to one
continuous block, with no blank lines.

```yaml
services:
  voice-server:
    image: wardpearce/korero-server:latest
    restart: unless-stopped
    ports:
      - "8443:8443/tcp"
      - "8444:8444/udp"
      - "8444:8444/tcp"
    volumes:
      - voice-data:/data
    environment:
      VOICE_DATA_DIR: /data
      VOICE_CONFIG: |
        [server]
        name = "My Kōrero server"
        registration = "invitation"
        # Shared password for sign-in and registration; "" disables it.
        # Invitations still work without it. Set VOICE_SERVER_PASSWORD
        # instead to keep the secret out of this file.
        password = ""
        # The public IP or hostname clients use for HTTPS/WSS.
        public_addresses = ["203.0.113.10"]
        [media]
        # The public IP or hostname clients can reach the media port on.
        announced_address = "203.0.113.10"
        # Voice quality in bits per second (32000-128000).
        target_audio_bitrate = 64000
        [messaging]
        # Keep message history for one week.
        retention_hours = 168
volumes:
  voice-data:
```

Every setting is optional, so drop any line to keep its default. `server.password` is a
shared password for sign-in and registration, and `server.registration` controls who may
create an account. See [Deployment](docs/deployment.md) for LAN, IPv6, VPN, NAT and backup
instructions.

# Manage a server

Right-click a connected server and choose **Server settings** to set the message of the day,
default role, default Opus bitrate, roles and permissions, and to browse the audit log.
Right-click a channel to change its password or bitrate.

To use `--config ./server.toml`, start the server from `backend/`. Host-side TOML changes apply
after a restart, and environment overrides take precedence. To administer from a browser, serve the
frontend over HTTPS or localhost and add its origin to `server.origins`.

# Share and chat

- **Files:** attach files up to 4 MiB by default; admins can set 1 to 32 MiB in **Server settings → Overview**.
- **Direct messages:** compare safety codes with your contact before reading or sending. Without persistence, the server deletes each message once delivered, or after `messaging.offline_delivery_hours`.
- **Screenshare and camera:** choose **Screenshare** or **Turn on camera**, adjust quality and start when ready. Available sources depend on your browser and OS.
  On Linux desktop, choose **Selected applications** under **Screen share audio** to include individual apps and set their outgoing volume before going live. Start playback in each app so it appears in the list. This requires `pactl` and `parec` (in `pulseaudio-utils` on Debian and Fedora), plus PulseAudio or PipeWire’s PulseAudio service.
- **Shortcuts:** use **Settings → Shortcuts** to set keys for microphone mute, deafen, AFK, talk, and whisper. Set the microphone input mode in **Settings → Audio**. Whisper defaults to **Alt+B**.

# Develop

Use Bun 1.4.5 and a Linux native build toolchain. On Debian 13 the worker needs
`build-essential ca-certificates libssl-dev meson ninja-build pkg-config`.

```sh
cd backend
bun install --frozen-lockfile --ignore-scripts
bun run prepare:worker
bun run check
bun run test
bun run start
```

For the client, run `bun run electron:dev` in `frontend/` on Linux x86_64, or `bun run mobile:sync`
to prepare the Android and iOS projects. See the [client build guide](docs/frontend-architecture.md).
Use `bun run db:generate --name=NAME` in `backend/` to generate a Drizzle migration.

# Documentation

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Authentication](docs/authentication.md)
- [Server identity and desktop trust](docs/server-identity.md)
- [Deployment and backups](docs/deployment.md)
- [Security](docs/security.md)
- [Compatibility and measurements](docs/compatibility.md)
- [Client architecture and build](docs/frontend-architecture.md)
- [Releasing](docs/releasing.md)
- [Server third-party notices](backend/THIRD_PARTY_NOTICES.md)

# Contributing

Contributions are welcome. Start with these guides:

- [Architecture](docs/architecture.md)
- [Client architecture and build](docs/frontend-architecture.md)
- [Security](docs/security.md)

# License

Korero.chat is licensed under the [AGPL-3.0](LICENSE).
