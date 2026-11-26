# Architecture

The server is one Bun process with a small pool of mediasoup C++ worker subprocesses.
Elysia owns HTTP and WebSocket I/O, validation and connection limits. Modules own
authentication, channels, presence and media independently of HTTP routing. One
process owns each data directory and the active connection map.

| Path | Responsibility |
| --- | --- |
| `src/config` | TOML defaults, environment overrides, networking validation |
| `src/database` | Drizzle schema, applied migration history, SQLite lifecycle and backups |
| `src/security` | Credential verifier key, generated TLS identity, filesystem integrity and rate limits |
| `src/modules/auth.ts` | Account and device credentials, invitation, setup and WebSocket tickets |
| `src/modules/realtime.ts` | Presence, channels, permission enforcement, messages and moderation |
| `src/modules/media.ts` | Worker pool, router lifecycle, WebRTC resources and speech activity |
| `src/protocol` | Language-independent input schemas shared by the transports |
| `src/app.ts`, `src/cli.ts` | Elysia entry points, first startup, operation and shutdown |
| `scripts`, `tests` | Native build, packaging and repeatable verification |

## Startup and storage

Configuration is checked before opening listeners. The process creates and locks the
data directory, applies checked-in Drizzle migrations, seeds roles and Lobby, and loads
the verifier key and TLS identity. Then it starts media workers and binds the
signalling endpoint. Shutdown closes WebSockets and peer media, reaps workers,
closes SQLite and releases the file lock.

Drizzle's Bun SQLite driver uses a single synchronous local connection with foreign keys
and WAL. Critical writes use immediate transactions, including setup token consumption,
invitation usage, credential rotation, and ban plus device revocation. Application SQL
is generated from Drizzle models. The database adapter handles SQLite connection flags,
the exclusive instance lock, and the backup snapshot. SQL migration files are generated
by Drizzle Kit and embedded into the standalone binary with their journal.

## Connection and media lifecycle

The ticket handshake binds a single socket to a device session. Online presence groups
connections by account. Channel maps contain connection IDs, so the same account can
join distinct channels from multiple devices. Each connection has at most one current
channel. Reconnection creates a new connection and fetches an authoritative snapshot.
Cached request replies are socket-local and bounded.

One server owns both accounts in a direct conversation. It resolves the
recipient’s public identity, accepts encrypted packets and delivers them to each
participant’s active device sessions, independent of channel membership. With
message persistence enabled, SQLite holds the packets until the configured
retention cutoff. Clients fetch their own inbox and history after reconnecting.

Each worker has a shared UDP/TCP WebRtcServer. The first media request in an occupied
channel creates its Opus router and audio-level observer on the least loaded available
worker. Peers use separate send and receive transports. Consumers start paused and
resume on a distinct request. Resource ownership plus channel authorization is checked
before and after asynchronous negotiation. A membership generation changes on each
leave or move, so late completions cannot attach resources to a replacement membership.

Leaving a channel closes all transports belonging to that membership. The final
departure releases the router and observer, and removes ephemeral channels.
Revocation closes all associated WebSockets and transports. A failed worker's rooms
are discarded, clients receive `media.reset`, and the server attempts a restart.
Producers are dropped when the user loses speaking permission or is muted. Speaking
events represent changes observed by the SFU, and a future E2EE design may need a
different mechanism.

## Trust boundaries

TLS secures signalling and device credentials. ICE and DTLS-SRTP establish an
independent client-to-SFU media hop. The SFU enforces producer and consumer access and
can access media in transit. It forwards encoded streams without decoding, mixing or
transcoding them. Clients control push-to-talk and audio input/output behaviour.
