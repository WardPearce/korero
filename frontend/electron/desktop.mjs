import { exportIdentity, generateIdentity, importIdentity, loadIdentity } from "./identity.mjs";
import { inspectServer, requireSuccess, Server } from "./server.mjs";
import { DesktopSession, offlineView, readCredentials } from "./session.mjs";
import { TalkShortcut } from "./shortcuts.mjs";

const publicEndpoints = new Set(["GET /api/v1/server/info", "GET /api/v1/server/capabilities"]);
const endpoints = new Set([
  "GET /api/v1/account", "GET /api/v1/account/sessions", "PATCH /api/v1/account", "PATCH /api/v1/account/picture",
  "GET /api/v1/admin/accounts", "GET /api/v1/admin/invitations", "GET /api/v1/admin/audit",
  "GET /api/v1/admin/password", "GET /api/v1/admin/preferences", "PATCH /api/v1/admin/roles",
  "PATCH /api/v1/admin/roles/definition", "DELETE /api/v1/admin/roles/definition", "PATCH /api/v1/admin/banner",
  "PATCH /api/v1/admin/password", "PATCH /api/v1/admin/preferences", "PATCH /api/v1/admin/badges",
  "PATCH /api/v1/channels/order", "POST /api/v1/admin/invitations", "POST /api/v1/admin/roles", "POST /api/v1/chat/attachments",
]);
const accountResource = /^\/api\/v1\/(?:account\/picture|connections|chat\/attachments)\/[\da-f-]{36}$/i;
const invitation = /^\/api\/v1\/admin\/invitations\/[\da-f-]{36}$/i;
const directOperations = new Set(["direct.peer", "direct.inbox", "direct.history", "direct.send", "direct.edit", "direct.delete", "direct.poke"]);
const mediaOperations = new Set([
  "media.capabilities", "media.transport.create", "media.transport.connect", "media.transport.close", "media.producers",
  "media.producer.create", "media.producer.close", "media.consumer.create", "media.consumer.resume", "media.consumer.close",
]);
const memberOperations = new Set(["channel.move", "moderation.mute", "moderation.deafen", "moderation.kick", "moderation.ban", "moderation.unban", "role.set"]);
const identityPaths = new Map([
  ["login", "/api/v1/auth/identity/login"], ["register", "/api/v1/auth/register"], ["bootstrap", "/api/v1/admin/bootstrap"],
]);

export class Desktop {
  #contacts = new Map();
  #servers = new Map();
  #shortcut = new TalkShortcut();
  #joining = Promise.resolve();
  #closed = false;

  constructor(emit) { this.emit = emit; }

  async #inspect(address) {
    const contact = await inspectServer(address);
    if (this.#contacts.size >= 64) this.#contacts.clear();
    this.#contacts.set(contact.info.origin, contact);
    return contact.info;
  }

  async #prepare(origin, fingerprint) {
    const contact = this.#contacts.get(origin);
    this.#contacts.delete(origin);
    if (!contact) throw new Error("Check the server certificate first.");
    const server = new Server(contact, fingerprint);
    const current = this.#servers.get(origin);
    const entry = { server };
    this.#servers.set(origin, entry);
    this.emit("korero:state", offlineView(origin));
    if (current) await this.#closeEntry(current);
    return origin;
  }

  #entry(origin) {
    const entry = this.#servers.get(origin);
    if (!entry) throw new Error("Select a server first.");
    return entry;
  }

  #session(origin) {
    const session = this.#servers.get(origin)?.session;
    if (!session) throw new Error("Connect to a server first.");
    return session;
  }

  #connection(id) {
    for (const { session } of this.#servers.values()) {
      if (session?.connectionId && session.connectionId === id) return session;
    }
    throw new Error("The server connection changed.");
  }

  async #authenticate({ origin, serverId, deviceName, privateKey, action }) {
    const entry = this.#entry(origin);
    if (entry.session?.started || entry.authenticating) throw new Error("Disconnect before signing in again.");
    const { operation, password, displayName, invitation, token } = action ?? {};
    const path = identityPaths.get(operation);
    if (!path) throw new Error("Unsupported identity operation.");
    const identity = loadIdentity(privateKey);
    const { publicKey } = identity;
    entry.authenticating = true;
    try {
      const challenge = requireSuccess(await entry.server.http("POST", "/api/v1/auth/identity/challenge",
        { operation, publicKey, deviceName, origin }));
      if (challenge.serverId !== serverId || challenge.origin !== origin || challenge.operation !== operation ||
          challenge.publicKey !== publicKey || challenge.deviceName !== deviceName || challenge.binding !== "" ||
          typeof challenge.id !== "string" || !Number.isFinite(challenge.expiresAt)) {
        throw new Error("The identity challenge does not match this server address or request.");
      }
      if (this.#servers.get(origin) !== entry) throw new Error("The selected session changed.");
      const id = challenge.id;
      const proof = { id, signature: identity.sign(["korero-identity-v1", serverId, origin, operation, id, publicKey, "", deviceName, challenge.expiresAt]) };
      const body = operation === "login" ? { ...proof, password } : {
        identity: proof, deviceName, displayName, password, ...(operation === "bootstrap" ? { token } : { invitation }),
      };
      const response = await entry.server.http("POST", path, body);
      if (response.status < 200 || response.status >= 300) return response;
      const credentials = readCredentials(response.body);
      const session = new DesktopSession(entry.server, credentials, (event, payload) => {
        if (this.#servers.get(origin) === entry && entry.session === session) this.emit(event, payload);
      });
      if (this.#servers.get(origin) !== entry) {
        await session.close();
        throw new Error("The selected session changed.");
      }
      const previous = entry.session;
      entry.session = session;
      if (previous) void previous.close();
      return { status: response.status, body: { account: response.body.account } };
    } finally { entry.authenticating = false; }
  }

  #fetch({ origin, method, path, body }) {
    if (typeof path !== "string" || !path.startsWith("/api/v1/")) throw new Error("Invalid API path.");
    const url = new URL(path, origin);
    if (url.origin !== origin || url.hash) throw new Error("Invalid API origin.");
    const route = `${method} ${url.pathname}`;
    if (publicEndpoints.has(route)) return this.#entry(origin).server.http(method, path, body);
    if (!endpoints.has(route) && !(method === "GET" && accountResource.test(url.pathname)) &&
        !(["PATCH", "DELETE"].includes(method) && invitation.test(url.pathname))) {
      throw new Error("Unsupported client HTTP operation.");
    }
    const session = this.#entry(origin).session;
    if (!session) throw new Error("You are not signed in.");
    return session.http(method, path, body);
  }

  #join(origin, channelId, password) {
    const task = this.#joining.then(async () => {
      const current = this.#session(origin);
      for (const [other, { session }] of this.#servers) {
        if (session && other !== origin) await session.leave();
      }
      await current.join(channelId, password);
    });
    this.#joining = task.catch(() => {});
    return task;
  }

  async #closeEntry({ server, session }) {
    try { await session?.close(); }
    finally { server.close(); }
  }

  async #disconnect(origin) {
    const entry = this.#servers.get(origin);
    this.#servers.delete(origin);
    this.emit("korero:state", offlineView(origin));
    if (entry) await this.#closeEntry(entry);
  }

  async close() {
    this.#closed = true;
    this.#shortcut.close();
    await Promise.allSettled([...this.#servers.keys()].map((origin) => this.#disconnect(origin)));
  }

  async invoke(command, args) {
    if (this.#closed) throw new Error("The desktop app is closing.");
    const { origin, channelId, connectionId, kind, payload, messageId, text, html } = args;
    switch (command) {
      case "inspect_server": return this.#inspect(args.address);
      case "prepare_server": return this.#prepare(origin, args.fingerprint);
      case "api_fetch": return this.#fetch(args);
      case "authenticate_identity": return this.#authenticate(args);
      case "generate_identity": return generateIdentity();
      case "export_identity": return exportIdentity(args.privateKey, args.passphrase);
      case "import_identity": return importIdentity(args.blob, args.passphrase);
      case "start_session": return this.#session(origin).start();
      case "voice_state": return [...this.#servers.values()].flatMap(({ session }) => session ? [session.view] : []);
      case "disconnect": return this.#disconnect(origin);
      case "join_channel": return this.#join(origin, channelId, args.password);
      case "leave_channel": return this.#session(origin).leave();
      case "set_presence": {
        const { muted, deafened, afk, afkMessage } = args;
        return this.#session(origin).setPresence({ muted, deafened, afk, afkMessage });
      }
      case "send_message": {
        const session = this.#session(origin);
        return session.run((wire) => {
          if (!session.channelId || (channelId && channelId !== session.channelId)) throw new Error("The active channel changed.");
          return wire.rpc("message.send", { channelId: session.channelId, text, html: html ?? undefined });
        });
      }
      case "edit_message": return this.#session(origin).run((wire) => wire.rpc("message.edit", { messageId, text }));
      case "delete_message": return this.#session(origin).run((wire) => wire.rpc("message.delete", { messageId }));
      case "save_channel": return this.#session(origin).saveChannel(payload);
      case "delete_channel": return this.#session(origin).run((wire) => wire.rpc("channel.delete", { channelId }));
      case "member_action": {
        if (!memberOperations.has(kind)) throw new Error("Unsupported member action.");
        return this.#session(origin).run((wire) => wire.rpc(kind, payload));
      }
      case "direct_request":
      case "media_request": {
        const media = command === "media_request";
        if (!(media ? mediaOperations : directOperations).has(kind)) throw new Error("Unsupported server operation.");
        const session = this.#connection(connectionId);
        return session.run((wire) => {
          if (session.connectionId !== connectionId || (media && (!channelId || session.channelId !== channelId))) {
            throw new Error("The active channel changed.");
          }
          return wire.rpc(kind, payload);
        });
      }
      case "configure_talk_shortcut": return this.#shortcut.configure(args.shortcut, (payload) => this.emit("korero:talk-shortcut", payload));
      default: throw new Error("Unsupported desktop operation.");
    }
  }
}
