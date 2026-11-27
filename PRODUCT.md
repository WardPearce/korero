# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are members of a self-hosted Korero.chat server who want to start and maintain one-to-one private conversations. They may already know the other person's user ID or need to find them among people on the same server. This audience and job were confirmed in the direct-messaging redesign request.

## Product Purpose

Korero.chat is a self-hosted, voice-first server with public-key accounts, hierarchical channels, moderation, and chat. The SvelteKit client also ships as an Electron desktop app and a Capacitor mobile app. For direct messaging, success means a member can share their own user ID, add someone by that ID, find server members, and reach a verified private conversation without hunting through unrelated UI.

## Positioning

The product combines direct-IP HTTPS and WebSocket signalling, a WebRTC SFU, public-key accounts, and encrypted direct messages. The server relays encrypted messages and holds them for offline delivery only when persistence is enabled. Before a device can read or send messages in a conversation, both accounts compare safety codes in person or over a trusted channel. The v1 protocol is open to independent clients.

## Operating Context

Members open direct messages from the channel sidebar or a member's menu. Both accounts use the same server. The client runs in a browser over HTTPS or localhost and as an Electron desktop app and a Capacitor mobile app. Server operators share a server address and TLS certificate details. Electron supports explicit certificate approval, and Capacitor uses device HTTPS trust.

## Capabilities and Constraints

- Frontend: SvelteKit, Svelte 5, Electron, Capacitor, Tailwind CSS 4, bits-ui, Lucide icons, TypeScript.
- Backend: Bun and Elysia, with an open v1 protocol and Drizzle persistence.
- User-confirmed redesign priorities: add a person by user ID, find people on the server, and share the current user's ID.
- User-confirmed success: DM home shows the current user's ID with one-click copy, an add-by-ID field, and a member picker, so sharing and adding both happen in seconds.
- User-confirmed scope: redesign the direct-messaging surface only. Keep the existing app identity, navigation elsewhere, and working security behavior.
- Safety-code verification remains part of starting a conversation; the redesign must make it clearer, not bypass it.
- Sharing is copy-first; QR-code-first was considered and not selected.

## Brand Commitments

The product is called Korero.chat; the repository and server package are named korero. The established app identity stays in place. Product language should stay direct, technical, and privacy-conscious, matching the existing documentation.

## Evidence on Hand

- `README.md`: product overview, sharing/chat workflow, security verification, development commands.
- `docs/protocol.md`: open v1 protocol.
- `frontend/package.json` and `backend/package.json`: stack, scripts, and product naming.

## Product Principles

- Make verification legible at the moment it matters; never trade clarity for convenience.
- Treat the user ID as the durable way to connect people across a self-hosted server.
- Support both discovery paths: a known ID and the shared server's member list.
- Keep task UI familiar and fast; reserve expression for meaningful state changes.
- Change the direct-messaging surface without disturbing the rest of the product or its security model.
