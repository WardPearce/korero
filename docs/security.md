# Security and privacy

The server implements independent passwordless accounts, expiring device sessions and
single-use WebSocket tickets. The database stores credential verifiers using separate
HMAC domains. A database-only compromise does not provide the HMAC key or usable
credentials. Parameterized Drizzle queries, strict message schemas, bounded queues,
connection limits and in-memory rate limits reduce guessing, malformed input and basic
resource exhaustion. They cannot absorb a large distributed denial-of-service attack.

Role checks, membership checks and resource ownership are verified on the server.
Privileges are opt-in in the default role map. The Owner role has all permissions and
is exempt from overrides. Other roles use the nearest channel or ancestor override
for that role and permission, then the server-level role grant. A role administrator
can act only on lower-ranked accounts and cannot assign their own rank or higher.
Reparenting a channel requires edit access at both parent scopes. Moves that
change inherited permissions also require role-management authority over the
affected roles and server-level grants for those permissions.
The original Owner cannot be demoted through the protocol. Channel passwords are
separate strings hashed using Argon2id. A moderator move can bypass the password
prompt but still checks target join permission and capacity.

TLS over signalling prevents passive observation of account credentials. Independent
verification of the first public-key pin and subsequent pin enforcement protect against
impersonation. A first TOFU connection without fingerprint verification can trust an
impersonator. Clients must protect the private identity key and its encrypted backups.
A stolen private key can sign new challenges as that identity. Stolen active session credentials can be used until
expiration, revocation, or detected refresh-token reuse.

Standard WebRTC encrypts media on each link to the SFU using DTLS-SRTP. The SFU and
server operator can access voice in transit and channel chat. The server never records
voice packets, has no telemetry, and offers optional chat persistence, disabled by default. Attachments
require an active session with matching channel membership and text permission.
With persistence enabled, attachments are stored in SQLite and expire with their
messages. Otherwise, they stay in memory for up to one hour. Connection IPs are used
for rate limiting in memory and can be visible to the network and infrastructure.
Keep TLS connection details, credentials, tickets and authentication bodies out of logs.

Direct message contents are end-to-end encrypted by the client. Each participant
verifies the conversation safety code through a trusted channel before using it.
This detects identity substitution by a relay. Use a trusted client build because
code running on either endpoint can read plaintext and access the local key.
The relay sees the participants, timestamps and packet sizes and can withhold
delivery. Retained messages use keys derived from the participants’ long-term
identities. Compromise of either private identity key exposes recorded ciphertext
for that identity. Importing the same identity on a different device preserves access
to retained history once the contact is verified on that device.

Security-sensitive actions are recorded using local IDs and timestamps. Startup prints
the one-off bootstrap token locally before the first Owner is created. Treat console
access and Docker logs as sensitive during first setup. Other audit records never
contain token values, channel passwords or text contents. A compromised host or
malicious administrator with local filesystem access is outside these guarantees.

Future payload encryption could use [SFrame, RFC 9605](https://www.rfc-editor.org/rfc/rfc9605.html)
and group key management such as [MLS, RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html).
WebRTC network metadata would still be visible.

For responsible disclosure, use the repository's private vulnerability reporting form
where enabled, or contact the repository owner privately. Include affected versions and
a description of the impact. Keep reports, sample credentials and user data out of
public issues until coordinated disclosure.
