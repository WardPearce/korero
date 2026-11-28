# Authentication

## Hosted accounts

Hosted accounts are optional. The app defaults to `account.korero.chat` in
production and `localhost` on the configured backend port in development. The
provider address is editable. A provider accepts new hosted accounts only when
`remote-account-host.registration` is `open` (the default is `closed`), up to
`limits.hosted_accounts`. `server.registration` and `server.password` apply only to
voice server accounts and do not affect hosted account registration. Existing hosted
accounts can sign in after registration closes. Account providers use HTTPS in production.

The client derives a key from the password using Argon2id. HKDF produces separate
keys for authentication and AES-256-GCM encryption. The client encrypts the
Ed25519 private key, server bookmarks, bookmarked server passwords, and appearance
settings before sending them to the provider. A saved server password is used
only for the bookmarked origin and server ID. Channel passwords are stored on
the device. Appearance sync includes the active theme, custom themes and their
backgrounds, and the frosted glass setting. Profiles larger than 64 KiB require
a provider and clients that support the 4 MiB encrypted profile limit.
The provider stores the username, a verifier for the derived sign-in credential,
and the encrypted data. The password and encryption key stay in the client.
Sign in with the same provider address, username, and password to restore the
data on another device. An encrypted identity export can also restore the key.
The app refreshes the hosted profile when it opens and returns to focus.
The app saves an encrypted copy of the hosted profile and the keys needed to
reopen it in device storage. Use **Sign out** in Account settings to clear the
saved sign-in on that device.

With local setup, the device stores the private key and saved servers. Voice
server sign-in continues to use Ed25519 challenges in both modes.

## Device links

You can sign another device, such as a phone, in to your identity by QR code.
Choose **Link a phone** in Identity settings on a device that is signed in.
On the new device, choose **Link from another device** at first launch, scan the
code, and type the 16-character link code shown beside it.

For a local identity, the QR code carries the private key, username, and saved
servers. The transfer is offline. For a hosted account, it carries the provider
address, username, sign-in credential, and encryption key, but not the password.
The new device signs in to the provider and decrypts the account profile,
including bookmarked server passwords and themes. Hosted sessions
started before device links were added cannot be shared. Sign out and sign in
again on that device first.

The QR payload is encrypted with AES-256-GCM under a key derived from the link
code using PBKDF2-SHA-256 with 600,000 iterations. The link code is 80 random
bits and is not part of the QR code, so a photo of the QR code alone is not
enough. Anyone who has both can sign in as you. Each time the dialog opens it
creates a new link and code, and closing it discards them. The new device signs
in to voice servers with the same Ed25519 challenges.

To let hosted sessions be linked, the device stores the account encryption key
as extractable. Script running in the app could read this key, so it relies on
the app's content security protections.

Use **Identity** settings to convert a local identity to a hosted account or to
transfer a hosted identity to another provider. Choose a username and password
for the destination account. The app encrypts the existing private key, server
bookmarks and their passwords, and appearance settings for the destination. It
switches providers after registration succeeds. The original identity remains
available from its previous location.

## Voice server accounts

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
bootstrap request. If the server has a shared password, claiming ownership also requires
that password. The bootstrap route returns `NOT_FOUND` once an Owner exists.
Regular identities can enroll before the owner claims the server if registration
permits it. A valid setup token can promote an existing identity to first Owner.

An Owner or Administrator can require a shared password for identity sign-in and
registration. When registration policy permits it, a valid invitation lets a new
member register and sign in again using the same identity without the shared password.
That access continues when the invitation expires, is used up, or is deleted, and
when the server password changes. Account bans still apply. The server stores an
Argon2id hash of the shared password. Existing sessions continue until they expire
or are revoked.
