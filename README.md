A self-hosted, voice-first server with direct-IP HTTPS and WebSocket signalling, an Opus SFU,
public-key accounts, persistent device sessions, hierarchical channels, moderation, and basic text.
The [v1 protocol](docs/protocol.md) is open to independent clients. The Bun/Elysia server lives in
[`backend/`](backend/). The SvelteKit and Tauri desktop client lives in [`frontend/`](frontend/).

## Develop the desktop client

Prepare the native media SDK and launch Tauri on Linux x86_64. See the
[client build guide](docs/frontend-architecture.md) for prerequisites, certificate setup,
and the native audio test.

## Manage a server

Right-click a connected server and choose **Server administration** to assign
built-in roles, issue invitations, set a shared sign-in password, or edit its
active configuration file. The first owner claims the server with its setup
token. Regular sign-in uses your VNX.chat identity and follows the server’s
registration policy. Right-click a channel to edit it, including its password,
or right-click a server to remove it from your device.

Start the server with `--config ./server.toml` from `backend/` to manage that
file specifically. Saved TOML changes apply after a restart. Environment
overrides take precedence. Change the storage directory on the host.

To use administration in a browser, serve the frontend over HTTPS or localhost,
add the frontend’s origin to `server.origins`, and use a server certificate
trusted by the browser. You can import an existing VNX.chat identity backup.
Voice uses the desktop app.

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
