# Protocol v1

Signalling uses HTTPS and text JSON WebSocket frames. Media uses standard WebRTC
ICE, DTLS-SRTP, RTP and RTCP. The HTTPS and WebSocket APIs may be implemented in any
language. [Authentication](authentication.md) defines credential semantics.
[Server identity](server-identity.md) defines certificate validation and pinning.

All times are Unix milliseconds. Durations whose names end in `Seconds` are seconds.
Object IDs are opaque lowercase UUID-formatted strings. Clients generate direct
message IDs and use a positive integer request ID in each WebSocket envelope. Clients should
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
| GET `/api/v1/server/info` | Public | — | `serverId, name, version, protocolVersions, registration, setupRequired, passwordRequired, invitationPasswordBypass, serverAdministration, bannerImageUrl, richChat?, maxWebSocketBytes?, fingerprint?` |
| GET `/api/v1/server/capabilities` | Optional | — | `protocolVersions, websocketPath, audio, targetAudioBitrate, heartbeatSeconds, maxWebSocketBytes, udp, tcp, textPersistence, iceServers?` |
| POST `/api/v1/auth/identity/challenge` | Public | `operation, publicKey, deviceName, origin` | Single-use challenge |
| POST `/api/v1/auth/identity/login` | Signed login challenge and server password where required | `id, signature, password?` | Account and new session |
| POST `/api/v1/admin/bootstrap` | Setup token and signed bootstrap challenge | `token, displayName, deviceName, identity` | Account and session |
| POST `/api/v1/auth/register` | Signed registration challenge, registration policy, and server password when configured for registration without an invitation | `displayName, deviceName, identity, invitation?, password?` | Account and session |
| POST `/api/v1/auth/refresh` | Refresh token in body | `refreshToken` | Rotated session credentials |
| POST `/api/v1/auth/logout` | Access token | — | `{}` |
| POST `/api/v1/auth/logout-all` | Access token | — | `{}` |
| POST `/api/v1/auth/connection-ticket` | Access token | — | `{ticket, expiresAt}` |
| GET `/api/v1/account` | Access token | — | Account |
| PATCH `/api/v1/account` | Access token | `displayName` | Account |
| GET `/api/v1/account/sessions` | Access token | — | Array of `id, deviceName, createdAt, lastActive, expiresAt` |
| POST `/api/v1/chat/attachments` | Access token and matching connection | `connectionId, channelId, text, html?, name, data` | `{messageId}` |
| GET `/api/v1/chat/attachments/:messageId` | Access token and matching connection | Query `connectionId` | `{data}` |
| DELETE `/api/v1/account/sessions/:id` | Access token | — | `{}` |
| GET `/api/v1/admin/accounts` | `manageRoles` | Query `after?` account ID | `accounts, next, roles, canDefineRoles, customRoles, assignablePermissions` |
| PATCH `/api/v1/admin/roles` | `manageRoles` | `accountId, role` | `{role}` |
| POST `/api/v1/admin/roles` | Administrator or Owner | `name, permissions` | `{name, permissions}` |
| PATCH `/api/v1/admin/roles/definition` | Administrator or Owner | `name, permissions` | `{name, permissions}` |
| DELETE `/api/v1/admin/roles/definition` | Administrator or Owner | `name` | `{}` |
| GET `/api/v1/admin/audit` | `viewAdmin` | Query `before?` audit ID, `actorId?`, `prefix?` event namespace | `{events, next}` |
| GET `/api/v1/admin/preferences` | `manageSettings` | — | Server preferences and allowed default roles |
| PATCH `/api/v1/admin/preferences` | `manageSettings` | `motd?, defaultRole?, defaultAudioBitrate?, maxAttachmentMiB?` | Updated server preferences |
| POST `/api/v1/admin/invitations` | `manageInvitations` | `expiresAt?, expiresInSeconds?, uses?` | `id, token, expiresAt, usesLeft` |
| GET `/api/v1/admin/invitations` | `manageInvitations` | — | `invitations` with non-deleted records |
| PATCH `/api/v1/admin/invitations/:id` | `manageInvitations` | `expiresAt?, usesLeft?` | Updated invitation record |
| DELETE `/api/v1/admin/invitations/:id` | `manageInvitations` | — | `{}` |
| PATCH `/api/v1/admin/banner` | `manageSettings` | `bannerImageUrl` as an HTTPS URL or `null` | `{bannerImageUrl}` |
| PATCH `/api/v1/channels/order` | `editChannels` | `channelId, targetId, placement` as `before`, `after`, or `inside`, with optional `parentId` | `{}` |
| GET `/api/v1/admin/password` | `manageSettings` | — | `{passwordRequired, passwordLocked}` |
| PATCH `/api/v1/admin/password` | `manageSettings` when `VOICE_SERVER_PASSWORD` is unset | `password` or `null` to remove it | `{passwordRequired}` |

An Account object has `id, displayName, role, createdAt`. Session responses have
`sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt` at the top
level alongside `account` for sign-in and account creation. Session listings
contain no token values. The capability response supplies ICE server settings
only to authenticated callers. Native requests may omit the Origin header.
Cross-origin browser requests require an exact match in `server.origins`.

Servers advertising `extendedServerAdministration` support server preferences,
role deletion, and HTTP audit history. Audit events are returned newest first,
with up to 100 entries. Pass `next` as `before` to continue with the same
filters. Entries include `id, action, createdAt, actorId, actorName, targetId,
targetName, details`. The log records account activity, connections, channel
membership, moderation, and administrative changes. It stores event metadata,
excluding credentials, message contents, and voice data.

Preferences apply live. Set `motd` to an empty string to clear the message.
Set `defaultAudioBitrate` to null to use the configured server value. The
`VOICE_MEDIA_TARGET_AUDIO_BITRATE` environment variable locks that default.
Changing `defaultRole` also requires `manageRoles` and affects new registrations.
The available choices include Guest, Member, and eligible custom roles with
basic member permissions. A custom role can be deleted after it is unassigned
from all accounts and replaced as the default, if selected.

Role changes require the actor to rank above both the account’s current role and
its new role and to hold the new role’s permissions. Custom roles share a rank
between Moderator and Administrator. Channel ordering requires permission to see and
edit both channels. `inside` appends the moved channel and its subtree to the target's
children. `before` and `after` order siblings. To use either across levels, send the
target's `parentId`, using `null` for the top level. A move to a new parent also
requires permission to see and edit that parent. Invitation expiration can use either a future Unix
timestamp in milliseconds or a lifetime in seconds. Omitting both leaves the
invitation without an expiration. Omitting `uses` allows unlimited registrations.
Invitation updates leave omitted fields as they are and use `null` to remove an
expiry or use limit. Setting `usesLeft` replaces the number of remaining uses.
Invitation listings and update responses contain metadata only. When
`invitationPasswordBypass` is advertised, a valid invite satisfies the shared
password requirement for account creation. The server password is read-only in
the API when the host sets `VOICE_SERVER_PASSWORD`.

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
members, serverPermissions, lowerRoles, assignableRoles, bannerImageUrl, canReorderChannels`.
Extended administration adds `motd` and the effective server `targetAudioBitrate`
in bits per second. Changes to either value trigger `state.invalidated`.
`lowerRoles` lists roles below the caller in the server hierarchy. `assignableRoles`
lists roles the caller can assign to a subordinate account. The channel list has
`id, parentId, name, description, position, capacity, temporary, passwordRequired, canMute, canReparent`.
Invisible parents are represented as null. Members have `connectionId, accountId,
displayName, role, muted, deafened, adminMuted, adminDeafened` and cover the socket's
current channel. Presence entries have
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
| `channel.create` | `name, description?, parentId?, position?, capacity?, password?, backgroundImageUrl?, audioBitrate?, temporary?` | `{channelId, state}` |
| `channel.edit` | `channelId` and editable creation fields other than `temporary` | `{channelId, state}` |
| `channel.delete` | `channelId` | `{}` |
| `channel.join` | `channelId, password?` | Snapshot |
| `channel.leave` | — | Snapshot |
| `channel.move` | `connectionId, channelId` | `{}` |
| `presence.set` | `muted?, deafened?, afk?, afkMessage?` | Member |
| `role.set` | `accountId, role` | `{}` |
| `channel.override` | `channelId, role, permission, allow` | `{}` |
| `moderation.mute` | `connectionId, muted` | `{}` |
| `moderation.deafen` | `connectionId, deafened` | `{}` |
| `moderation.kick` | `accountId` | `{}` |
| `moderation.ban` | `accountId, expiresInSeconds?` | `{}` |
| `moderation.unban` | `accountId` | `{}` |
| `invitation.create` | `expiresAt?, expiresInSeconds?, uses?` | `{id, token, expiresAt, usesLeft}` |
| `invitation.list` | — | Latest 100 invitation records without tokens or verifiers |
| `invitation.update` | `invitationId, expiresAt?, usesLeft?` | Updated invitation record |
| `invitation.revoke` | `invitationId` | `{}` |
| `server.settings` | `name?, registration?` | `{}` |
| `admin.diagnostics` | — | Counts, process CPU and memory, worker PID and native resource usage where available |
| `admin.audit` | `before?` audit ID | Latest 100 matching audit records |
| `message.send` | `channelId, text, html?` | `{messageId}` |
| `message.history` | `channelId` and optional `before` timestamp | Up to 100 channel messages in descending time order |
| `message.delete` | `messageId` | `{}` |
| `direct.peer` | `accountId` | `accountId, displayName, publicKey, ownPublicKey` |
| `direct.inbox` | — | Up to 50 recent contacts with `accountId, displayName, lastMessageAt` |
| `direct.history` | `accountId, before?: {createdAt, id}` | `{messages, next}` |
| `direct.send` | `accountId, id, nonce, ciphertext, signature` | `{messageId}` |

Server mute and deafen require `mute` at server scope and in the target channel.
They apply to a subordinate account identified by its connection ID and persist
across connections. Server mute blocks producers. Server deafen blocks producers
and consumers independently of self-deafen. Enabling either restriction closes
affected media resources. Clients recreate producers or consumers once allowed.
Kicking closes all account connections. Banning also
revokes all device sessions. Temporary rooms are joined on creation and disappear
when empty. Channel history requires current channel membership and text permission.
History is empty when text persistence is disabled. Current live text still works.
Message objects contain `id, channelId, recipientId, senderId, createdAt, text`
and may include `html` and attachment metadata as `attachment: {name, size}`.
When server info advertises `richChat`, clients may send an optional `html`
representation of the same content, up to 32,768 characters. Keep `text` as the
plain-text representation. `maxWebSocketBytes` caps the UTF-8 request envelope.
Treat received markup as untrusted and render it only
after sanitizing it against a strict formatting allowlist, or display `text`.
Channel message objects have a null `recipientId`.
An attachment is sent as one channel message with an optional caption. Use standard
padded base64 for `data`. Server info and connection snapshots advertise the current
decoded file limit as `maxAttachmentBytes`. Administrators can set `maxAttachmentMiB`
from 1 to 32 in `PATCH /api/v1/admin/preferences`. The default is 4 MiB.
Upload and download both require text permission in the connection's
current channel. Downloads return encoded data separately from history and events.
Persistent attachments expire and are deleted with their message. In-memory
attachments are available for up to one hour. The in-memory quotas are 8 MiB per
sender and 32 MiB per server by default. A higher file limit raises those caps to
at least one file per sender and four files per server. Persistent storage is
limited to 32 MiB per sender and 256 MiB per server. Each account has a download
budget of 60 requests and 32 MiB of decoded file data, refilled over one minute.

AFK is connection-scoped. While `afk` is true, both `muted` and `deafened` are
reported as true and the server closes and blocks producers and consumers for
that connection. Setting `afk` to false restores its self-mute and self-deafen
settings. Channel members include `afk` and `afkMessage` in snapshots and member
events. Messages are single lines of up to 120 characters and are shared while
AFK. An empty string clears the message.

## Encrypted direct messages

Snapshots advertise `directMessages: {maxBytes, persistent}`. Both accounts live
on the selected server. Sending requires server-level `text` permission and a
recipient with an enrolled identity. The server derives the sender from the
authenticated socket and delivers `direct.created` to both accounts’ active
devices. Packets include `id, senderId, recipientId, createdAt, nonce, ciphertext,
signature`. The server supplies `createdAt` and uses it for retention and history order.

With `persistent` enabled, the recipient can be offline when the server accepts
the packet. The sender can retry an identical stored packet using the same ID.
History returns up to 10 packets newest first, breaking ties by ID. Pass the
returned `next` as `before` to load another page. With persistence disabled, inbox
and history are empty and sending to a wholly offline account returns `CONFLICT`.
The encrypted requests are separate from channel chat. The server rejects legacy
plaintext direct-message sends.

Clients check that `ownPublicKey` matches their enrolled identity and verify the
conversation safety code out of band before sending or decrypting. Compute the code
as the first 16 bytes of SHA-256, rendered as hex, over the UTF-8 compact JSON array
`["korero-direct-safety-code-v1", serverId, participants]`. Each participant is
`[accountId, publicKey]` and the two entries sort by account ID. Pin the verified
code locally and refuse a changed value.

Convert the local Ed25519 seed and the peer’s validated Ed25519 public key to
X25519 with a standard implementation. Reject small-order and non-prime-order peer
points and an all-zero shared secret. Generate a random UUIDv4 `id` and a random
12-byte nonce for each message. Derive a 32-byte AES key from the shared secret
using HKDF-SHA-256 with a 32-byte zero salt and the UTF-8 compact JSON array
`["korero-direct-message-v1", serverId, senderId, recipientId, id]` as the
information parameter. Use the same array as AES-256-GCM associated data. Encrypt
1 to `maxBytes` of UTF-8 text and append the 16-byte authentication tag.
Encode the nonce and tagged ciphertext as unpadded base64url. Extend the associated-data
array with the two encoded strings in that order, sign its UTF-8 compact JSON
with Ed25519 and encode that signature as unpadded base64url. Clients verify the
signature against the pinned sender identity and authenticate the ciphertext
before displaying text.

## WebRTC negotiation

Use the object field names and types from the [mediasoup v3 RTP reference](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/)
and [transport API](https://mediasoup.org/documentation/v3/mediasoup/api/).
A client must join first, load the router RTP capabilities, then negotiate
its send and receive transports separately. Media operations use membership and
ownership scope. Client-supplied account IDs never establish media ownership.

| Type | Payload fields | Success payload |
| --- | --- | --- |
| `media.capabilities` | `kind?: "video"` | Router RTP capabilities, plus `iceServers` for video |
| `media.transport.create` | `direction` (`send` or `receive`), `forceTcp?`, `kind?: "video"`, `videoSource?: "camera"`, `whisperChannelId?`, `whisperPassword?` | `{id, iceCandidates, iceParameters, dtlsParameters}` |
| `media.transport.connect` | `transportId, dtlsParameters` | `{}` |
| `media.transport.close` | `transportId` | `{}` |
| `media.transport.stats` | `transportId` | mediasoup WebRTC transport stats array |
| `media.ice.restart` | `transportId` | New ICE parameters |
| `media.producers` | — | Array of accessible `producerId, connectionId, paused, speaking` |
| `media.producer.create` | `transportId, kind, rtpParameters` with kind `audio` or `video` | `{id}` |
| `media.producer.pause`, `resume`, `close` | `producerId` | `{}` |
| `media.consumer.create` | `transportId, producerId, rtpCapabilities` | `{id, producerId, accountId, kind, rtpParameters, producerPaused}` |
| `media.consumer.pause`, `resume`, `close` | `consumerId` | `{}` |

On the sending side, route the WebRTC transport's DTLS connect and produce
callbacks through their respective requests. On the receiving side, create the
consumer on the server, add the matching WebRTC consumer locally, then send
`media.consumer.resume`. For late joins, query `media.producers` before consuming.
For ICE restart, apply the returned ICE parameters through the client transport.
If the worker resets or the client changes rooms, discard stale media IDs and transports.

Voice uses Opus at 48 kHz. SDP advertises Opus with two-channel capability
as required for interop. Clients default to mono capture and can negotiate stereo,
DTX, FEC and a target 20 ms packetization interval where supported. The advertised
target bitrate defaults to 48 kbit/s. A channel's `audioBitrate` can override
the server default with a value from 32000 to 128000 bits per second. Setting it
requires `manageSettings` and the applicable channel editing permissions. Use
`null` to inherit the server default. Use the effective bitrate in the sender's
Opus codec options. Actual throughput depends on the encoder and network.

Servers advertising `screenSharing` support a separate screen transport in each
direction. Screen sharing uses VP8 and can include one Opus source-audio track.
Publish optional source audio before publishing video. Discover both IDs in the
snapshot's `screens` array or through `media.screenAvailable`. A repeat event for
the same video producer updates its audio ID. Consuming screen media requires
a screen receive transport. `media.producers` lists microphone audio.

A microphone send transport can set `whisperChannelId` to route only to a
different occupied channel. The sender stays joined to their source channel.
Close the normal microphone send transport before requesting a whisper transport.
The sender needs permission to speak in the source and to join and speak in the
destination. Supply `whisperPassword` when the destination has a password. The
destination password and both channels' permissions are rechecked during the
route lifetime. The destination receives the usual microphone producer events
with `whisperFrom` on `media.producerAvailable`. Its snapshot lists the current
whispers as `{producerId, from}`. Read-only views of other rooms omit that list.
The transport closes when the sender leaves or is muted, deafened or AFK, or when
the destination empties or becomes inaccessible. `media.whisperEnded` reports
the source `channelId` and closed `transportId` to the sender.

An array in the snapshot's `cameras` field indicates webcam support. For camera
send and receive transports use `kind: "video"` with `videoSource: "camera"`.
Camera transports carry VP8 video at up to 6 Mbit/s. They are separate from
screen transports, which continue to use the default video source. A camera
produces one video track and uses the joined channel's speak permission. Self-mute
affects microphone voice while camera video stays on. Discover camera producers
in `cameras` or through `media.cameraAvailable`.

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
| `direct.created` | Encrypted direct message packet |
| `media.producerAvailable` | `channelId, producerId, connectionId` |
| `media.producerClosed` | `channelId, producerId` |
| `media.producerState` | `producerId, paused` |
| `media.screenAvailable` | `channelId, producerId, connectionId, audioProducerId?` |
| `media.screenClosed` | `channelId, producerId` |
| `media.screenTransportFailed` | `channelId, transportId, reason` |
| `media.cameraAvailable` | `channelId, producerId, connectionId` |
| `media.cameraClosed` | `channelId, producerId` |
| `media.cameraTransportFailed` | `channelId, transportId, reason` |
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
