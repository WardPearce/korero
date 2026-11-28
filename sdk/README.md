# Korero.chat TypeScript SDK

Build clients and bots for the [Korero v1 protocol](../docs/protocol.md). The SDK runs in modern browsers with Web Crypto, Bun, and Node.js 22+. Each `KoreroClient` owns a connection to one server.

## Install

```sh
npm install korero-chat
```

## Listen and respond

```ts
import { Channel, KoreroClient, identityFromPrivateKey } from "korero-chat";

const client = new KoreroClient("https://chat.example.org:8443");
const identity = identityFromPrivateKey(process.env.KORERO_PRIVATE_KEY!);
const channel = new Channel(process.env.KORERO_CHANNEL_ID!, client);

client.on("messageCreate", (message) => {
  if (message.senderId === client.state.snapshot?.account.id) return;
  if (message.text === "!ping") {
    void message.channel.send("Pong!").catch(console.error);
  }
});

await client.connect({ identity, deviceName: "Ping bot" });
await channel.follow();
```

Create an identity once with `generateIdentity()` and store its private key securely. On first connection, pass `action: { operation: "register", displayName: "Ping bot", invitation }` to `connect()` to enroll it. Use the same identity on later runs. An invitation is needed when the server requires one. If the server requires a password, include it in the action. An encrypted Korero identity backup can also be loaded with `importIdentity()`.

`client.channel(id)` is shorthand for `new Channel(id, client)`. Use `channel.send()`, `channel.history()`, `channel.join()`, `channel.edit()`, and `channel.delete()` as permitted by the server. A client can follow one channel alongside its joined channel. `client.disconnect()` closes signaling and revokes the device session. Create a new client for a new connection after disconnecting.

## Events and other operations

| Event | Payload |
| --- | --- |
| `ready` | Initial server snapshot |
| `state` | Connection status, current snapshot, and recent messages |
| `messageCreate` | Live `ChannelMessage` with its channel and edit/delete methods |
| `messageUpdate` / `messageDelete` | Message ID and any updated content |
| `directMessage` / `directMessageChange` | Encrypted packet or edit/delete |
| `poke` | Incoming poke |
| `raw` | Original signaling event with its protocol type and payload |

Use `on`, `once`, and `off` to manage handlers. Register handlers before connecting to receive offline direct messages. Use `client.api` for typed HTTP operations such as account settings and administration. For end-to-end encrypted direct messages, `client.directPeer()`, `directConversation()`, and `client.sendDirect()` provide peer lookup, encryption and signing, and delivery. Check your enrolled public key and verify the conversation safety code with the recipient before sending or decrypting. See the [direct-message protocol](../docs/protocol.md#encrypted-direct-messages) for the verification requirements.

The default transport uses the runtime's HTTPS trust store and WebSocket implementation. For custom certificate trust, pass a `Transport` to the constructor. Browser callers also need their origin allowed by the server. The SDK accepts a media adapter for clients with voice support.
