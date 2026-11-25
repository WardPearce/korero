# Deployment

Run the binary on supported Linux or use the container. Persistent data includes
`server.db`, `server.toml`, `identity/tls.pem`, and `secrets/credentials.key`.
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
interface, forward WebSocket upgrades, and have the proxy overwrite
`X-Forwarded-For` with one client IP. The backend ignores that header from other peers.
The client must separately reach the SFU's UDP or TCP media port. Optional external
STUN/TURN URLs and credentials are configured as `media.ice_servers` and exposed only to
an authenticated caller. The client implements ICE server use.

## Configuration and TLS

Start with [server.example.toml](../backend/server.example.toml). Precedence is the explicit
CLI path or data directory, then `VOICE_CONFIG` or `VOICE_DATA_DIR`, then
`[storage].directory` if specified in the selected TOML, then `./data`.
Otherwise the server reads `server.toml` from the selected data directory if it exists.
Ordinary settings use `VOICE_<SECTION>_<KEY>` over TOML over defaults. Supply JSON for
environment booleans, numbers, lists and tables. Server name and registration can also
be persisted via the authorised WebSocket API. On restart, those saved values override
TOML unless explicitly set by environment. Environment-managed values cannot be
changed through the API.

- `self-signed` is the default. Clients verify a public-key pin.
- `manual` loads `tls.certificate` and an owner-only `tls.private_key`. Use PEM,
  including intermediary certificates in the certificate file when applicable.
- `proxy` delegates TLS to the explicitly configured proxy.
- `disabled` accepts only a loopback HTTP bind for development.
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

Compilation uses the matching Linux toolchain, Bun 1.4.5, and system OpenSSL
development files at version 3.5.9 or newer. Linux kernels and glibc requirements
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
