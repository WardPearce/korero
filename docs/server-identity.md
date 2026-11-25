# Server identity

The server stores a random logical server ID in SQLite. Its cryptographic
identity is the SHA-256 hash of the TLS certificate's DER-encoded
SubjectPublicKeyInfo. The display format is `sha256/` followed by padded
standard Base64. Compare the full 32 bytes.

Self-signed mode creates an ECDSA P-256 key and a 365-day X.509 certificate.
SANs include loopback, concrete local interface IPs, and configured public
names and media addresses. Add additional signalling endpoints under
`tls.names` or `server.public_addresses`. On startup the server renews a
certificate nearing expiry or missing a SAN using the same key. Periodically
restart long-running self-signed servers so renewal occurs before expiry.
The private key and certificate are replaced together in the owner-only
`identity/tls.pem`. Manual mode reads a certificate chain and separate key.

## Pinning and first contact

1. Parse the target as `host:port` or bracketed `[IPv6]:port`. Make a TLS probe
   that sends no application credentials. Read the leaf certificate from the TLS handshake.
2. Display the SPKI fingerprint and have the user compare it against the operator's
   trusted display or exported certificate. Require explicit approval.
3. Open a fresh TLS connection using a per-server verifier. Require a well-formed
   leaf, an appropriate server authentication key and certificate validity at the
   current time, an exact IP SAN or a valid DNS SAN match for the requested endpoint,
   the approved SPKI digest, and a valid handshake signature proving key possession.
   Reject expired or premature certificates and unexpected keys. Self-signed mode
   trusts the explicitly approved key as its trust anchor. Don't use a permissive
   global verifier or a bare certificate fingerprint in place of handshake verification.
4. Over that verified connection call `GET /api/v1/server/info`. Check the
   returned server ID against any earlier trusted binding. Only then attach access,
   refresh, invitation or recovery credentials.
5. Require explicit approval for a changed public key. A different logical server ID
   also requires a new trust decision and credential namespace. Renewal with the
   same key and server ID continues to work.

Without independent fingerprint verification, TOFU cannot detect an active impersonator
on the first connection. With a publicly trusted certificate, use normal certificate-chain,
validity and DNS or IP verification through the platform trust store. Proxy mode uses the
identity presented by the proxy. The HTTP body's fingerprint field is optional metadata
and cannot establish trust.

Stop the server before using the local CLI to inspect or change identity.

```sh
voice-server --data-dir ./data identity fingerprint
voice-server --data-dir ./data identity export > server-public.crt
voice-server --data-dir ./data identity rotate --yes
```

Rotating the key requires every pinned client to verify and approve the new key before
reconnecting. Restore the full data directory to preserve both the logical ID and its key.

## Rust and Tauri

Use native Rust for endpoint parsing, TLS, HTTP and WebSockets. Use a shared per-server
`rustls::ClientConfig` for both connections. For private pins, a scoped
`ServerCertVerifier` should check the certificate criteria above and delegate TLS 1.2
and 1.3 signature verification and supported signature schemes to rustls's selected
crypto provider. Use a current X.509 parser and disallow redirects across origins in
credential-bearing HTTP requests. Use independently scoped connection pools.

Pass the config into `reqwest` through its preconfigured rustls API and into
`tokio-tungstenite` through its Rustls connector. Keep the dependency versions
compatible across both transports. Store refresh credentials with the platform
credential manager and send only the application state the webview needs.
Bridge mediasoup-client's transport, produce and consume signalling calls through the
native connection. The webview can use its normal WebRTC peer connections for audio;
it needs no HTTP/WSS certificate bypass.

- [rustls verifier contract](https://docs.rs/rustls/latest/rustls/client/danger/trait.ServerCertVerifier.html)
- [reqwest ClientBuilder](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html)
- [tokio-tungstenite TLS connector](https://docs.rs/tokio-tungstenite/latest/tokio_tungstenite/enum.Connector.html)
