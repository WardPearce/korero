# Authentication

Every server has its own accounts. Registration accepts a display name, a device name,
and proof of an Ed25519 identity. Names may repeat. The server assigns a random account
ID, associates it with the public key, and returns device credentials.

## Identity sign-in

The client sends the public key and signs the server's single-use challenge locally.
A challenge is bound to the server, origin, operation, public key, and device name.
It expires after 60 seconds. The server verifies the signature before creating a new
device session for that key. Import the original identity from an encrypted backup
to sign in from another device. Losing the private key and its backup ends the user's
ability to create new sessions for that account.

The server stores domain-separated HMAC-SHA-256 verifiers. A 32-byte random key is created
in `secrets/credentials.key` with owner-only access. Include it in encrypted backups.
Losing it makes existing session credentials unusable. Access token lookups use indexed
verifiers. Checks against a specific stored verifier use constant-time comparisons.

## Devices and refresh

An account can have multiple independently revocable sessions. The access token lasts
15 minutes by default. The refresh token expires after 90 days without refresh. Only a
successful refresh extends this lifetime. Last activity in the session list is updated
at most once per minute per device from authenticated activity, plus on each refresh.

Refresh atomically replaces both credentials. Serialize refreshes per device in the
client. For 10 seconds by default, a retry of the immediately previous token returns
the same successor pair and expiry while that pair is current. Successors are derived
from the random predecessor using secret, domain-separated HMACs, so the database can
store only verifiers. An already advanced successor returns `REFRESH_RETRY` during the
retry window. Replay after the window revokes the whole device session and its sockets.
A stolen refresh token used within the retry window can obtain the same successor.
The client should retry uncertain responses promptly and replace stored tokens together.

A WebSocket authenticates with a single-use ticket from an authenticated HTTP request.
The socket follows the device session's expiry and revocation. It continues through
normal access-token expiration. HTTP refresh extends the device lifetime and the client
can present a new same-device ticket using `connection.renew` without interrupting voice.
A fresh connection always uses a fresh ticket.

Use the OS credential store for refresh tokens and their associated server and device
identity. Keep access tokens and tickets in memory when possible. Remember the public
server pin separately from credentials. Keep bearer credentials out of webview storage,
HTTP request URLs, debug logs, and crash reports. On device logout remove its local credentials.

## Registration and setup

`open` accepts registrations without an invitation. `invitation` requires a valid
invitation. `admin` requires an invitation issued by an Administrator or Owner.
`disabled` blocks new registrations. Existing identities can still sign in.
Administrators can create multiple invitations, each with an optional expiry and
registration limit, and edit or delete them. Moderators can manage their own
invitations in open and invitation-only registration. Copy each invitation when
you create it and share it privately as `server-address#invite-code`. Paste the full
link into the app's server address field to join.
The first Owner uses a separate, 15-minute, locally displayed setup token and an atomic
bootstrap request. The bootstrap route returns `NOT_FOUND` once an Owner exists.
Regular identities can enroll before the owner claims the server if registration
permits it. A valid setup token can promote an existing identity to first Owner.

An Owner or Administrator can require a shared password for identity login and
registration. A valid invitation replaces the shared password for that registration.
Registration mode and proof of identity still apply. A later sign-in to an existing
account requires the shared password when configured. The server stores its Argon2id
hash. Existing sessions continue until they expire or are revoked.
