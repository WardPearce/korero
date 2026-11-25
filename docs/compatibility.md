# Compatibility

The phase 0 proof passed on Fedora 43 Linux AMD64 with Bun 1.4.5, Elysia 1.4.32,
mediasoup 3.32.2, mediasoup-client 3.26.0, and Chromium headless shell. It exercised
the native worker's additional stdio pipes through mediasoup's unmodified Bun
execution path. Both the source process and the compiled executable created a worker,
shared UDP/TCP WebRtcServer, Opus router and WebRTC transports, answered HTTP and
WebSocket calls, wrote to Bun SQLite, and relayed decoded non-silent audio between
two Chromium pages. SIGTERM stopped each worker and the probe checked that its PID
was gone. The compiled process extracted and checked its embedded worker before
loading mediasoup. Bun's single executable still uses a dynamically linked worker.
The tested worker links to glibc, libstdc++, libgcc_s, and libm on AMD64.

An initial harness run established ICE/DTLS and received Opus RTP but did not start
decoded playout. The harness now starts playback with a muted audio element and
checks the decoded signal through Web Audio.

Run `bun tests/compatibility/run.ts` after dependency and Chromium installation.
Set `CHROMIUM_PATH` to select an existing compatible Chromium headless shell.

## Hardened worker builds

The initial upstream prebuilt worker linked OpenSSL 3.0.10 statically. The production
build uses the same mediasoup 3.32.2 source with Meson linking to system OpenSSL 3.5.9
or newer and a runtime version check in the native entry point. This addresses
published DTLS fixes that an npm-only audit cannot check. The builder sources come
from the locked npm package and its hashed Meson wraps. [OpenSSL advisories](https://openssl-library.org/news/vulnerabilities/), [mediasoup upstream issue](https://github.com/versatica/mediasoup/issues/1989)

| Environment | Verified result |
| --- | --- |
| Fedora 43 Linux AMD64, glibc 2.42, OpenSSL 3.5.9, Bun 1.4.5 | Source and standalone phase-zero proof, strict TypeScript check, Bun tests, and native worker shutdown |
| Fedora 43 Linux AMD64, Chromium headless shell 159.0.8154.6, mediasoup-client 3.26.0 | Standalone authenticated Opus over IPv4 loopback UDP, IPv6 loopback TCP, and the host's private IPv4 LAN address over UDP |
| Debian 13 Linux AMD64 container, glibc 2.41, libstdc++ 14.2, OpenSSL 3.5.9 | Native build, unit and integration tests, published-port Opus, non-root startup without network access, and stable identity after a volume-backed restart |
| Linux ARM64 | Native CI matrix configured. This workspace is AMD64 and has no native ARM64 runner. |

The tests used two independent Chromium sessions on the same machine. The browser harness
used an ephemeral test-only SPKI exception for its assigned server key. Independent
HTTPS/WSS tests checked the expected fingerprint, SAN and certificate trust, including
preventing a recovery request to an unexpected key. The compiled worker's native
dependencies included glibc, libstdc++, libgcc_s, libm, libssl, libcrypto, and the host's
transitive zlib. Debian 13 is the verified clean baseline. Older platforms and other
architectures need verification before support is claimed.

The integration suite exercises concurrent bootstrap and refresh, ticket expiry and
replay, recovery rotation, permission enforcement, media worker replacement, and a
backup/restore that preserves accounts, channels and TLS keys. The end-to-end suite
checks decoded audio and ownership, administrative mute, switching channels, and
active-session revocation. The npm audit found zero advisories in the resolved lockfile
at verification time.

## Measured voice workload

These measurements used the hardened standalone AMD64 executable on a Ryzen 7 7800X3D
with a single media worker, Chromium on the same machine, one synthetic Opus speaker,
and all other participants listening. The active sample lasted five seconds.

| Participants | Server and worker RSS | Server and worker CPU (% of one core) | SFU transport ingress / egress | Median / maximum setup to decoded audio |
| --- | --- | --- | --- | --- |
| 4 | 94.8 / 14.5 MiB | 0.87% / 0.32% | 83.2 / 208.8 kbit/s | 188 / 189 ms |
| 16 | 99.8 / 16.1 MiB | 0.62% / 0.96% | 157.8 / 1033.3 kbit/s | 879 / 1165 ms |

Bandwidth is the sum of mediasoup transport byte deltas and includes transport traffic.
Setup time starts before producer negotiation and ends when each browser detects
decoded audio. Browser scheduling and negotiation contribute to it. It is not
one-way steady-state mouth-to-ear latency. These two samples support no capacity
claim for concurrent speakers or internet paths.

```sh
bun tests/e2e/benchmark.ts dist/voice-server-linux-amd64 4 16
```
