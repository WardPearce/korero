# Deployment

Run the binary on supported Linux or use the container. Persistent data includes
`server.db`, the file-based `server.toml` when present, `identity/tls.pem`, and
`secrets/credentials.key`.
The bundled native SFU is verified and extracted into a versioned workers directory.
Use a local filesystem with advisory SQLite file locking and executable file support.
Run one server per data directory under a dedicated system user.

## Ports and direct IP

| Default port | Protocol | Purpose |
| --- | --- | --- |
| 8443 | TCP | HTTPS and secure WebSocket |
| 8444 | UDP | WebRTC media |
| 8444 | TCP | WebRTC fallback |

Each extra media worker takes one more consecutive port with the same selected protocols.
On a LAN, use the endpoint and fingerprint printed at startup. If the host has multiple
interfaces, bind media to the desired concrete IPs with `media.listen_ips`. The default
uses discovered local IPv4 and non-link-local IPv6 addresses. For an overlay network
such as WireGuard or Tailscale, use the host's reachable overlay address. Include it in
`tls.names` if it is unavailable to automatic enumeration. Link-local IPv6 interface
scopes are excluded from automatic ICE configuration. Test several client network paths
before relying on a link-local deployment.

On the public internet, set an announced IPv4 or hostname using
`media.announced_address`, and optionally `media.announced_ipv6`. A wildcard media bind
requires an announced address of that family. Explicitly set
`server.public_addresses` for additional HTTPS SANs. Forward the same external media
port numbers to the corresponding server ports. To advertise different local and
public candidates over distinct local interfaces or IP aliases of the same family,
use `media.listen = [{ ip = "192.168.1.100" }, { ip = "192.168.1.101", announced_address = "203.0.113.10" }]`
and forward to the address in the public candidate's entry. NAT can require forwarding for both
UDP and TCP. CGNAT can prevent inbound IPv4 forwarding entirely. Use reachable IPv6,
a VPN, or another deployment topology when needed. TCP fallback helps only if peers
can reach the media TCP port. A domain name and a TLS certificate establish naming and
identity independently of network reachability.

DNS is optional. Hostname candidates require DNS resolution by clients. The server
never queries an external IP service. Ordinary HTTPS proxies forward signalling only.
For proxy TLS, configure exact `server.trusted_proxies`, keep the backend on a private
interface, and forward WebSocket upgrades. The proxy may overwrite or append to
`X-Forwarded-For`. The backend takes the rightmost entry that is not a trusted proxy as
the client and ignores the header from other peers. IPv6 clients are rate limited per /64.
The client must separately reach the SFU's UDP or TCP media port. Optional external
STUN/TURN URLs and credentials are configured as `media.ice_servers` and exposed only to
an authenticated caller. The client implements ICE server use.

## Configuration and TLS

HTTPS is always used for the voice server. Clients connect with a server IP/host; the port defaults to 8443 when omitted, e.g. `example.com` or `example.com:8443`.

Start with [server.example.toml](../backend/server.example.toml). Precedence is the explicit
CLI path or data directory, then `VOICE_CONFIG` or `VOICE_DATA_DIR`, then
`[storage].directory` if specified in the selected TOML, then `./data`.
Otherwise the server reads `server.toml` from the selected data directory if it exists.
`VOICE_CONFIG` may name a file or contain the TOML document itself. Inline content is
recognised when it starts with a section header or comment, so a container can supply the
whole configuration through its environment instead of mounting a file. Inline settings
are not written back to the data directory; a backup stores them as `server.toml` so a
restored instance starts with the same configuration.
Ordinary settings use `VOICE_<SECTION>_<KEY>` over TOML over defaults. Supply JSON for
environment booleans, numbers, lists and tables. Server name can also be persisted
via the authorised WebSocket API. On restart, that saved value overrides TOML unless
explicitly set by environment. Registration and `server.max_users` are host-only:
set them in TOML or with `VOICE_SERVER_REGISTRATION` / `VOICE_SERVER_MAX_USERS`.
The API cannot change them. Environment-managed values cannot be changed through
the API.

Edit the TOML on the host, or the `VOICE_CONFIG` value in the container environment,
and restart to apply it. Set `VOICE_SERVER_PASSWORD` to
manage the shared password on the host. An explicitly empty value disables the shared
password for that run. Unset the variable to use the TOML or the saved app password again.

Pending WebSocket connections are limited to 64 globally and four per client IP
by default. Configure `limits.pending_connections` and
`limits.pending_connections_per_ip` on the host. For pools with two or more
slots, one source can use at most half the pool.

Realtime and attachment rate limits are per-minute token buckets and can be
raised or lowered on the host. The defaults are 3600 WebSocket requests, 1800
media operations, 30 ICE restarts, 60 channel joins and 120 chat messages per
minute, plus 120 attachment uploads, 240 attachment downloads and 128 MiB of
downloaded file data per account per minute. Up to 32 attachment uploads run
concurrently. The matching settings are `limits.websocket_requests_per_minute`,
`limits.media_per_minute`, `limits.ice_restarts_per_minute`,
`limits.channel_joins_per_minute`, `messaging.per_minute`,
`limits.attachment_uploads_per_minute`, `limits.attachment_downloads_per_minute`,
`limits.attachment_download_bytes_per_minute` and
`limits.attachment_uploads_concurrent`. With persistence enabled, stored
attachments are limited to 2 GiB per server and 256 MiB per sender by default
(`limits.stored_attachment_bytes` and
`limits.stored_attachment_bytes_per_account`). HTTP sign-in requests are limited
to 60 per client IP per minute (`limits.auth_per_minute`). Server-wide, they are
also capped at the largest of 240, eight times that value and four per allowed
user (`server.max_users`). Each source can hold up to 16 pending identity
challenges. Valid refresh tokens and authenticated ticket requests have separate
limits per device session and per account, respectively. Each account can hold up
to eight simultaneous WebSocket connections (`limits.connections_per_account`).

`messaging.stored_message_bytes` sets a shared budget for channel messages and
encrypted direct messages, including offline delivery. The default is 512 MiB of
stored payloads and per-message overhead. Attachment quotas apply separately.
Upgrades count existing messages toward the budget. If the server is already over
budget, message writes that increase storage return `LIMIT` until deletions or
retention cleanup free enough space.

`limits.hosted_account_bytes` budgets hosted profiles separately. The default is
1 GiB including a 256-byte allowance per account. Existing profiles count toward
the budget. Providers over budget continue to serve profiles and accept updates
that stay the same size or shrink. `limits.hosted_account_requests_concurrent`
caps concurrent hosted registration and update body reads at 16 by default.

Audit history defaults to 100,000 events and 90 days. Set `limits.audit_events`
and `limits.audit_retention_hours` to adjust those limits. The server trims
excess records in batches. `limits.profile_updates_per_minute` limits display-name
updates to 10 per account per minute by default.

`media.max_audio_ingress_bitrate` caps incoming microphone and whisper RTP at
256 kbit/s per transport by default. `media.max_rtp_egress_bitrate` defaults to
250 Mbit/s of outgoing RTP across the server, divided equally among the media
workers. Both include packet overhead and allow a one-second burst.

When upgrading from channel-scoped administration grants, existing denials for
`createChannels`, `editChannels`, `removeChannels`, and `move` still apply to
the role and inherit down the channel tree. Scoped allows for these actions are
removed as the grants move to server scope.

- `self-signed` is the default. Clients verify a public-key pin.
- `manual` loads `tls.certificate` and an owner-only `tls.private_key`. Use PEM,
  including intermediary certificates in the certificate file when applicable.
- `proxy` delegates TLS to the explicitly configured proxy. The proxy must present TLS to clients.
- ACME can provision the manual paths or be handled by the proxy. Built-in ACME is deferred.

```sh
voice-server --config ./server.toml config validate
voice-server --data-dir ./data
```

## Docker

```sh
VOICE_MEDIA_ANNOUNCED_ADDRESS=192.168.1.100 docker compose up --build -d
docker compose logs voice-server
```

The image reads `server.toml` from `/data` by default. To keep the whole configuration in
Compose instead, put the TOML document in `VOICE_CONFIG`; a leading `[section]` or `#`
comment distinguishes inline TOML from a file path. Keep it to one continuous block, with
no blank lines:

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
        name = "Voice Server"
        registration = "invitation"
        # Shared password for sign-in and registration; "" disables it.
        # Invitations still work without it. Set VOICE_SERVER_PASSWORD
        # instead to keep the secret out of this file.
        password = ""
        public_addresses = ["voice.example.com"]
        [media]
        announced_address = "203.0.113.10"
volumes:
  voice-data:
```

Per-setting environment overrides such as `VOICE_MEDIA_ANNOUNCED_ADDRESS` still take
precedence over `VOICE_CONFIG`. Inline configuration is validated the same way as a file:

```sh
docker compose run --rm voice-server config validate
```

Set the announced address to the address clients use to reach the Docker host.
Use appropriate host firewall rules and enable IPv6 on the host and Docker network for
an IPv6 deployment. For persistent bind mounts, provision the directory so UID/GID
10001 owns it. The named Compose volume uses the container's existing owner.
Local container health checks only query the unauthenticated readiness endpoint.

An expired setup token is replaced locally while the server is stopped.

```sh
docker compose stop voice-server
docker compose run --rm --no-deps voice-server admin setup-token --yes
docker compose up -d
```

## Backup and restore

Stop the server, then create a backup in a new directory outside the data directory.

```sh
voice-server --data-dir ./data backup --output ./voice-backup
```

The command locks the instance and uses SQLite's backup snapshot operation to write
committed WAL data into a self-contained database. It includes the selected TOML,
credential verifier key and self-signed identity, plus the manual TLS files when used.
Wait for `BACKUP_COMPLETE` before archiving the directory. Keep backups confidential
and remember separately managed environment overrides and reverse-proxy secrets.

To restore, stop the old instance, copy the backup into an owner-only directory, point
`--data-dir` at it, and reapply any environment overrides. If using manual TLS, adjust
the configured certificate and key paths to the restored copies. Check the displayed
fingerprint against existing clients' pins. Restoration can resurrect devices or
credentials that were valid at snapshot time. Rotate or revoke them again if necessary.

## Build dependencies and platform support

Compilation uses the matching Linux toolchain, Bun 1.4.5, and patched system OpenSSL
development files. The media worker requires at least 3.5.9 on OpenSSL 3.5,
3.6.5 on OpenSSL 3.6, or 4.0.3 on OpenSSL 4.0. Linux kernels and glibc requirements
depend on the native build host. The release workflow builds in Debian 13 for AMD64
and ARM64. See [Compatibility](compatibility.md) for results and measured requirements.

```sh
sudo apt-get install build-essential ca-certificates libssl-dev meson ninja-build pkg-config
bun install --frozen-lockfile --ignore-scripts
bun run build
cd backend
bun scripts/notices.ts
```

The native build uses the locked mediasoup source and Meson wraps. The resulting
executable embeds the worker and does not download dependencies at startup. A target
host needs patched OpenSSL shared libraries, glibc and libstdc++. No OpenSSL CLI or
compiler is used at runtime.
