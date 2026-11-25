# Authentication

Every server has its own accounts. Registration accepts a display name and device name.
Names may repeat and play no part in authentication. The server assigns a random UUID
and returns a recovery code and device credentials in the registration response.
Recover on a new device using only the recovery code and a name for the new device.

## Recovery codes

Codes encode 32 cryptographically random bytes as 52 Crockford Base32 characters
in 13 groups of four. The decoder ignores case, spaces, and hyphens and accepts common
letter substitutions. The last character contains one payload bit and four zero pad bits.
The code has no checksum. Keep an offline copy in a place only the user can access.

A recovery code is a long-term bearer credential. Anyone in possession can create a
device session as that account. The server returns a new code once when it is created
or rotated. Recovering a session leaves the current code valid. Administrators cannot
retrieve existing codes. Losing the code and every authenticated device can permanently
end access. A malicious operator with control of the server can issue credentials or
observe authentication requests.

The server stores domain-separated HMAC-SHA-256 verifiers. A 32-byte random key is created
in `secrets/credentials.key` with owner-only access. Include it in encrypted backups.
Losing it makes existing credentials unusable. Recovery and access lookups use indexed
verifiers. Checks against a specific stored verifier use constant-time comparisons.

To rotate, present an access token and the current recovery code in the same request.
The database commits the replacement and, by default, revokes all other device sessions
in the same transaction. If the response is lost, the old code is already invalid and
the replacement cannot be reissued by support or derived from the database. The current
device session remains valid. Keep it active and contact the server operator if needed.

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
server pin separately from credentials. Avoid webview storage, URLs, debug logs, and
crash reports for all bearer credentials. On device logout remove its local credentials.

## Registration and setup

`open` accepts registrations without an invitation. `invitation` requires a valid
invitation. `admin` requires an invitation issued by an Administrator or Owner.
`disabled` blocks new registrations, while recovery still works for existing accounts.
Administrators can create invitations with an expiry and/or use limit and revoke them.
Moderators can create and revoke their own invitations in open and invitation-only
registration.
The first Owner uses a separate, 15-minute, locally displayed setup token and an atomic
bootstrap request. The bootstrap route returns `NOT_FOUND` once an Owner exists.
