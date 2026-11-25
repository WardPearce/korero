# Protocol v1

Signalling uses HTTPS and text JSON WebSocket frames. Media uses standard WebRTC
ICE, DTLS-SRTP, RTP and RTCP. The HTTPS and WebSocket APIs may be implemented in any
language. [Authentication](authentication.md) defines credential semantics.
[Server identity](server-identity.md) defines certificate validation and pinning.

All times are Unix milliseconds. Durations whose names end in `Seconds` are seconds.
Server-generated IDs are opaque lowercase UUID-formatted strings. The exception
is the positive integer request ID in each WebSocket envelope. Clients should
preserve unknown fields in extensible media data and ignore unknown events.
Request schemas are available as [JSON Schema](protocol-v1.schema.json). References
such as `#/$defs/websocketRequest` select individual schemas.

## HTTP

Set `Content-Type: application/json` on requests with a body. Authenticated routes
require `Authorization: Bearer <accessToken>`. Error responses carry
`{"error":{"code":"AUTH_FAILED","message":"Authentication failed"}}`. Use the error
code for control flow. Error prose may change. Successful writes use 200 or 201.
A credential-bearing response carries `Cache-Control: no-store`.

| Method and path | Auth | Input | Successful result |
| --- | --- | --- | --- |
| GET `/health` | Public | — | `{status:"ok"}` |
| GET `/ready` | Public | — | `{status:"ready"}`, or 503 with `{status:"unavailable"}` |
| GET `/api/v1/server/info` | Public | — | `serverId, name, version, protocolVersions, registration, setupRequired, fingerprint?` |
| GET `/api/v1/server/capabilities` | Optional | — | `protocolVersions, websocketPath, audio, targetAudioBitrate, heartbeatSeconds, maxWebSocketBytes, udp, tcp, textPersistence, iceServers?` |
| POST `/api/v1/auth/identity/challenge` | Public | `operation, publicKey, deviceName, origin` | Single-use challenge |
| POST `/api/v1/auth/identity/login` | Signed login challenge | `id, signature` | Account and new session |
| POST `/api/v1/admin/bootstrap` | Setup token and signed bootstrap challenge | `token, displayName, deviceName, identity` | Account and session |
| POST `/api/v1/auth/register` | Signed registration challenge and invitation where required | `displayName, deviceName, identity, invitation?` | Account and session |
| POST `/api/v1/auth/refresh` | Refresh token in body | `refreshToken` | Rotated session credentials |
| POST `/api/v1/auth/logout` | Access token | — | `{}` |
| POST `/api/v1/auth/logout-all` | Access token | — | `{}` |
| POST `/api/v1/auth/connection-ticket` | Access token | — | `{ticket, expiresAt}` |
| GET `/api/v1/account` | Access token | — | Account |
| PATCH `/api/v1/account` | Access token | `displayName` | Account |
| GET `/api/v1/account/sessions` | Access token | — | Array of `id, deviceName, createdAt, lastActive, expiresAt` |
| DELETE `/api/v1/account/sessions/:id` | Access token | — | `{}` |

An Account object has `id, displayName, role, createdAt`. Session responses have
`sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt` at the top
level alongside `account` for sign-in and account creation. Session listings
contain no token values. The capability response supplies ICE server settings
only to authenticated callers. Native requests may omit the Origin header.
A supplied browser Origin must exactly match an entry in `server.origins`.

For `login`, `register`, or `bootstrap`, request a challenge for the raw 32-byte
Ed25519 public key encoded in base64url without padding. Verify the returned server
ID, origin, operation, key, device name, and empty binding. Sign the UTF-8 bytes of
the compact JSON array below with the private key. `id` is the challenge nonce and
`expiresAt` is in Unix milliseconds.

```text
["korero-identity-v1", serverId, origin, operation, id, publicKey, "", deviceName, expiresAt]
```

Encode the signature as base64url without padding. Send `{id, signature}` to the
login endpoint or as `identity` in the enrollment request. A valid login proof for
an unregistered key returns `NOT_FOUND`.

## WebSocket connection and envelopes

1. Check that discovery lists v1. Obtain a fresh ticket through the HTTP API.
2. Open `wss://<host>:<port>/api/v1/ws` with the same certificate trust decision.
3. Within five seconds send the authentication request. The outer version identifies
   the handshake format and `versions` lists the versions the client can use.
4. On success the response contains an authoritative snapshot. Join a channel
   explicitly. Send `heartbeat` every 25 seconds, or keep the connection active with
   other requests. The idle timeout is 60 seconds.
5. After disconnect, obtain a new ticket, reconnect, join again, and recreate media.
   `state.get` recovers a snapshot whenever an event is missed or state is invalidated.

```json
{"version":1,"id":1,"type":"connection.authenticate","payload":{"ticket":"<43-character token>","versions":[1]}}
```

```json
{"version":1,"id":2,"type":"channel.join","payload":{"channelId":"00000000-0000-4000-8000-000000000001"}}
```

```json
{"version":1,"id":2,"type":"response","success":false,"error":{"code":"FORBIDDEN","message":"Operation not permitted"}}
```

```json
{"version":1,"id":3,"type":"response","success":true,"payload":{}}
```

```json
{"version":1,"type":"channel.changed","payload":{"channelId":null}}
```

Requests use strictly increasing positive integers up to JavaScript's safe-integer
maximum, with a fresh sequence on reconnect. One connection executes requests in order.
Retransmitting an identical retained request ID and JSON object returns the cached
response. Keep member ordering and serialization stable for retries. The server
caches up to 16 completed, validly framed requests within a 256 KiB response budget. A changed or forgotten ID at or
below the high-water mark returns `CONFLICT`. A malformed envelope without a usable
ID receives an error with ID zero if the socket remains writable. A reconnect does
not replay mutations. Reconcile state before retrying operations across connections.

A successful snapshot has `connectionId, account, channelId, channels, presence,
members, serverPermissions`. The channel list has `id, parentId, name, description,
position, capacity, temporary, passwordRequired`. Invisible parents are represented
as null. Members have `connectionId, accountId, displayName, muted, deafened,
adminMuted` and cover the socket's current channel. Presence entries have
`accountId, displayName, connections` and count all online devices by account.

Oversized frames, a full pending request queue or outbound backpressure may close
the socket. Treat close code 4401 as a need to reauthenticate, 4403 as a kick, and
4429 as a limit. Ticket renewal can extend a session without tearing down media.
A revoked device receives 4401 and its transports are closed.

## Application requests

Use `{}` for an empty payload. Optional fields are indicated by `?`.
Omitted edit fields retain their value. `null` clears nullable parent, capacity,
password or permission-override fields.

| Type | Payload fields | Success payload |
| --- | --- | --- |
| `connection.renew` | `ticket` for the same device | `{expiresAt}` |
| `heartbeat` | — | `{time, sessionExpiresAt}` |
| `state.get` | — | Snapshot |
| `channel.create` | `name, description?, parentId?, position?, capacity?, password?, temporary?` | `{channelId, state}` |
| `channel.edit` | `channelId` and editable creation fields other than `temporary` | `{channelId, state}` |
| `channel.delete` | `channelId` | `{}` |
| `channel.join` | `channelId, password?` | Snapshot |
| `channel.leave` | — | Snapshot |
| `channel.move` | `connectionId, channelId` | `{}` |
| `presence.set` | `muted?, deafened?` | Member |
| `role.set` | `accountId, role` | `{}` |
| `channel.override` | `channelId, role, permission, allow` | `{}` |
| `moderation.mute` | `connectionId, muted` | `{}` |
| `moderation.kick` | `accountId` | `{}` |
| `moderation.ban` | `accountId, expiresInSeconds?` | `{}` |
| `moderation.unban` | `accountId` | `{}` |
| `invitation.create` | `expiresInSeconds?, uses?` | `{id, token, expiresAt, usesLeft}` |
| `invitation.list` | — | Latest 100 invitation records without tokens or verifiers |
| `invitation.revoke` | `invitationId` | `{}` |
| `server.settings` | `name?, registration?` | `{}` |
| `admin.diagnostics` | — | Counts, process CPU and memory, worker PID and native resource usage where available |
| `admin.audit` | `before?` audit ID | Latest 100 matching audit records |
| `message.send` | `text` and one of `channelId, accountId` | `{messageId}` |
| `message.history` | One of `channelId, accountId`, plus `before?` timestamp | Up to 100 messages in descending time order |
| `message.delete` | `messageId` | `{}` |

Moderation mute applies to the account associated with the supplied connection ID
and persists across connections. It removes existing producers. Self-mute or deafen
also removes voice resources in the affected directions. Clients recreate producers
or consumers once allowed. Kicking closes all account connections. Banning also
revokes all device sessions. Temporary rooms are joined on creation and disappear
when empty. Channel history requires current channel membership and text permission.
History is empty when text persistence is disabled. Current live text still works.
Message objects contain `id, channelId, recipientId, senderId, createdAt, text`.
Exactly one of channel or recipient ID is non-null.

## WebRTC negotiation

Use the object field names and types from the [mediasoup v3 RTP reference](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/)
and [transport API](https://mediasoup.org/documentation/v3/mediasoup/api/).
A client must join first, load the router RTP capabilities, then negotiate
its send and receive transports separately. Media operations use membership and
ownership scope. Client-supplied account IDs never establish media ownership.

| Type | Payload fields | Success payload |
| --- | --- | --- |
| `media.capabilities` | — | Router RTP capabilities |
| `media.transport.create` | `direction` (`send` or `receive`), `forceTcp?` | `{id, iceCandidates, iceParameters, dtlsParameters}` |
| `media.transport.connect` | `transportId, dtlsParameters` | `{}` |
| `media.transport.close` | `transportId` | `{}` |
| `media.transport.stats` | `transportId` | mediasoup WebRTC transport stats array |
| `media.ice.restart` | `transportId` | New ICE parameters |
| `media.producers` | — | Array of accessible `producerId, connectionId, paused, speaking` |
| `media.producer.create` | `transportId, kind:"audio", rtpParameters` | `{id}` |
| `media.producer.pause`, `resume`, `close` | `producerId` | `{}` |
| `media.consumer.create` | `transportId, producerId, rtpCapabilities` | `{id, producerId, kind, rtpParameters, producerPaused}` |
| `media.consumer.pause`, `resume`, `close` | `consumerId` | `{}` |

On the sending side, route the WebRTC transport's DTLS connect and produce
callbacks through their respective requests. On the receiving side, create the
consumer on the server, add the matching WebRTC consumer locally, then send
`media.consumer.resume`. For late joins, query `media.producers` before consuming.
For ICE restart, apply the returned ICE parameters through the client transport.
If the worker resets or the client changes rooms, discard stale media IDs and transports.

The only codec is Opus at 48 kHz. SDP advertises Opus with two-channel capability
as required for interop. Clients default to mono capture and can negotiate stereo,
DTX, FEC and a target 20 ms packetization interval where supported. The advertised
target bitrate defaults to 48 kbit/s. Set it in the sender's codec options as a hint.
Actual throughput depends on the encoder, packets, feedback and network. The protocol
does not represent it as a server-enforced bandwidth ceiling.

## Events

| Event | Payload |
| --- | --- |
| `presence.changed` | `accountId, displayName, connections` |
| `presence.offline` | `accountId` |
| `channel.userJoined`, `channel.userChanged` | `channelId` and Member fields |
| `channel.userLeft` | `channelId, connectionId, accountId` |
| `channel.changed` | `channelId` or null for a move or removal by the server |
| `state.invalidated` | `{}`, re-fetch snapshot |
| `server.changed` | `name, registration` |
| `message.created` | Message |
| `message.deleted` | `messageId` |
| `media.producerAvailable` | `channelId, producerId, connectionId` |
| `media.producerClosed` | `channelId, producerId` |
| `media.producerState` | `producerId, paused` |
| `media.consumerClosed` | `consumerId, producerId` |
| `media.speaking` | `producerId, speaking` |
| `media.transportState` | `transportId, state` |
| `media.transportFailed` | `transportId, reason` |
| `media.reset` | `channelId, reason` |

Events can arrive before the response to the operation that triggered them.
Speaking is sampled from SFU audio-level observations, so it may not represent
every transition or identify silent clients.

## Error codes

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | Invalid envelope, fields or operation input |
| `VERSION_UNSUPPORTED` | 400 | Server and client could not agree on a version |
| `AUTH_FAILED` | 401 | Missing, invalid, expired or revoked credentials |
| `FORBIDDEN` | 403 | Authorization or origin check failed |
| `NOT_FOUND` | 404 | Resource unavailable in the caller's scope |
| `CONFLICT` | 409 | Request conflicts with current state |
| `REFRESH_RETRY` | 409 | A newer refresh generation already exists |
| `LIMIT` | 429 | Resource limit |
| `RATE_LIMITED` | 429 | Request rate exceeded |
| `UNAVAILABLE` | 503 | Media worker or service unavailable |
| `INTERNAL` | 500 | Unexpected server failure |
