import { requireSuccess } from "./server.mjs";

const mediaEvents = new Set([
  "media.producerAvailable", "media.producerClosed", "media.consumerClosed", "media.whisperEnded", "media.transportFailed", "media.reset",
]);
const snapshotEvents = new Set(["state.invalidated", "presence.changed", "presence.offline", "channel.changed"]);
const directMessageLimit = 200;
const channelMessageLimit = 200;
const isSameDirectMessage = (a, b) => a.id === b.id && a.senderId === b.senderId && a.recipientId === b.recipientId;


/** Applies a live reaction change; `me` only changes when the reacting account is this one. */
function applyReaction(reactions = [], change, mine) {
  const current = reactions.find(({ emoji }) => emoji === change.emoji);
  const me = mine ? change.reacted : current?.me ?? false;
  const next = current ? reactions.map((entry) => entry === current ? { ...entry, count: change.count, me } : entry)
    : [...reactions, { emoji: change.emoji, count: change.count, me }];
  return next.filter(({ count }) => count > 0);
}

export function offlineView(origin) {
  return { origin, phase: "offline", snapshot: null, messages: [], messageRevisions: {}, directMessages: [], lastPoke: null, lastMention: null, speaking: [], error: null };
}

export function readCredentials(value) {
  if (typeof value?.accessToken !== "string" || typeof value.refreshToken !== "string" ||
      typeof value.sessionId !== "string" || !Number.isFinite(value.accessExpiresAt) || !Number.isFinite(value.refreshExpiresAt)) {
    throw new Error("The server did not create a session.");
  }
  const { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, sessionId } = value;
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, sessionId };
}

export class DesktopSession {
  #queue = Promise.resolve();
  #refresh;
  #wire;
  #heartbeat;
  #reconnect;
  #attempts = 0;
  #abort = new AbortController();
  #presence = {};
  #room;
  #audioSources = new Map();
  #speaking = new Set();
  /** A channel whose chat is followed without joining it. */
  #viewed = null;
  /** Channels whose history has been loaded on the current wire. */
  #loaded = new Set();

  constructor(server, credentials, emit) {
    this.server = server;
    this.credentials = credentials;
    this.emit = emit;
    this.view = offlineView(server.origin);
    this.started = false;
  }

  get connectionId() { return this.view.snapshot?.connectionId; }
  get channelId() { return this.view.snapshot?.channelId; }

  #show(patch, directChange) {
    if (this.#abort.signal.aborted) return;
    this.view = { ...this.view, ...patch };
    this.emit("korero:state", directChange ? { ...this.view, directChange } : this.view);
  }

  #enqueue(work) {
    const task = this.#queue.then(work);
    this.#queue = task.catch(() => {});
    return task;
  }

  run(work) {
    return this.#enqueue(async () => {
      const wire = this.#wire;
      if (this.view.phase !== "online" || !wire) throw new Error("Connect to a server first.");
      return work(wire);
    });
  }

  async #accessToken() {
    this.#abort.signal.throwIfAborted();
    const current = this.credentials;
    if (current.refreshExpiresAt <= Date.now()) throw new Error("AUTH_FAILED: Device session expired. Recover your account to reconnect.");
    if (current.accessExpiresAt > Date.now() + 15000) return current.accessToken;
    this.#refresh ??= this.server.http("POST", "/api/v1/auth/refresh", { refreshToken: current.refreshToken },
      undefined, this.#abort.signal).then((response) => {
      const next = readCredentials(requireSuccess(response));
      if (next.sessionId !== current.sessionId) throw new Error("The refreshed device session changed.");
      this.credentials = next;
      return next.accessToken;
    }).finally(() => { this.#refresh = undefined; });
    return this.#refresh;
  }

  async http(method, path, body) {
    return this.server.http(method, path, body, await this.#accessToken(), this.#abort.signal);
  }

  async #ticket() {
    const token = await this.#accessToken();
    const { ticket } = requireSuccess(await this.server.http("POST", "/api/v1/auth/connection-ticket", undefined, token, this.#abort.signal));
    if (typeof ticket !== "string") throw new Error("The server did not issue a connection ticket.");
    return { ticket, token };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.#connect();
  }

  #connect() {
    if (this.#abort.signal.aborted) return;
    this.#show({ ...offlineView(this.server.origin), phase: this.#attempts ? "reconnecting" : "connecting" });
    void this.#enqueue(async () => {
      let wire;
      try {
        const capabilities = requireSuccess(await this.http("GET", "/api/v1/server/capabilities"));
        if (capabilities.websocketPath !== "/api/v1/ws" || !Number.isSafeInteger(capabilities.maxWebSocketBytes) ||
            capabilities.maxWebSocketBytes <= 0 || !Number.isFinite(capabilities.heartbeatSeconds)) {
          throw new Error("Unsupported signaling capabilities.");
        }
        const credentials = await this.#ticket();
        this.#abort.signal.throwIfAborted();
        wire = this.server.socket(capabilities.maxWebSocketBytes,
          (source, event) => {
            void this.#enqueue(async () => {
              if (this.#wire === source && this.view.phase === "online") await this.#event(source, event);
            }).catch((error) => { if (this.#wire === source) this.#show({ error: error.message }); });
          },
          (source, error) => {
            void this.#enqueue(() => { if (this.#wire === source) this.#retry(error); });
          });
        this.#wire = wire;
        const snapshot = await wire.rpc("connection.authenticate", { ticket: credentials.ticket, versions: [1] });
        let error = null;
        if (Object.keys(this.#presence).length) {
          try { await wire.rpc("presence.set", this.#presence); }
          catch (failure) {
            if (this.#presence.afk) { this.#room = undefined; error = failure.message; }
          }
        }
        let current = snapshot;
        if (this.#room) {
          try { current = await wire.rpc("channel.join", this.#room); }
          catch (failure) { this.#room = undefined; error = failure.message; }
        }
        this.#abort.signal.throwIfAborted();
        this.#attempts = 0;
        this.#show({ phase: "online", snapshot: current, error });
        await this.#history(wire);
        await this.#receiveQueued(wire, snapshot.account.id);
        let token = credentials.token;
        const heartbeatMs = Math.max(5, Math.min(30, capabilities.heartbeatSeconds)) * 1000;
        let nextHeartbeat = Date.now() + heartbeatMs;
        const schedule = () => {
          if (this.#wire === wire) this.#heartbeat = setTimeout(heartbeat, Math.min(10000, nextHeartbeat - Date.now()));
        };
        const heartbeat = async () => {
          if (this.#wire !== wire || this.#abort.signal.aborted) return;
          try {
            if (await this.#accessToken() !== token) {
              const next = await this.#ticket();
              await wire.rpc("connection.renew", { ticket: next.ticket });
              token = next.token;
            }
            if (Date.now() >= nextHeartbeat) {
              await wire.rpc("heartbeat");
              nextHeartbeat = Date.now() + heartbeatMs;
            }
            schedule();
          } catch (failure) {
            void this.#enqueue(() => { if (this.#wire === wire) this.#retry(failure); });
          }
        };
        schedule();
      } catch (error) {
        if (!this.#abort.signal.aborted) this.#retry(error);
      }
    });
  }

  #retry(error) {
    this.#clearWire();
    if (this.#abort.signal.aborted) return;
    if (error.message.startsWith("AUTH_FAILED:") || error.message.includes("(4403)")) {
      this.started = false;
      this.#show({ ...offlineView(this.server.origin), phase: "error", error: error.message });
      return;
    }
    this.#show({ ...offlineView(this.server.origin), phase: "reconnecting", error: error.message });
    this.#reconnect = setTimeout(() => this.#connect(), 1000 * 2 ** Math.min(this.#attempts++, 4));
  }

  #clearWire() {
    this.#audioSources.clear();
    this.#speaking.clear();
    clearTimeout(this.#heartbeat);
    clearTimeout(this.#reconnect);
    this.#viewed = null;
    this.#loaded.clear();
    const wire = this.#wire;
    this.#wire = undefined;
    wire?.close();
  }

  async close() {
    this.#abort.abort();
    this.#clearWire();
    const signal = AbortSignal.timeout(2000);
    try {
      let credentials = this.credentials;
      if (credentials.accessExpiresAt <= Date.now() && credentials.refreshExpiresAt > Date.now()) {
        credentials = readCredentials(requireSuccess(await this.server.http("POST", "/api/v1/auth/refresh",
          { refreshToken: credentials.refreshToken }, undefined, signal)));
      }
      await this.server.http("POST", "/api/v1/auth/logout", undefined, credentials.accessToken, signal);
    } catch {}
  }

  #replaceSnapshot(snapshot) {
    const changed = this.channelId !== snapshot.channelId;
    if (changed) {
      this.#audioSources.clear();
      this.#speaking.clear();
    }
    this.#show(changed ? { snapshot, speaking: [] } : { snapshot });
    this.#keepChatMessages();
    return changed;
  }

  /** The joined channel and the viewed channel, whose messages this session keeps. */
  #chatChannels() {
    return new Set([this.channelId, this.#viewed].filter(Boolean));
  }

  #keepChatMessages() {
    const channels = this.#chatChannels();
    for (const id of this.#loaded) if (!channels.has(id)) this.#loaded.delete(id);
    const messages = this.view.messages.filter(({ channelId }) => channels.has(channelId));
    if (messages.length !== this.view.messages.length) this.#show({ messages });
  }

  /** Loads history for kept channels that have none yet. Runs on the session queue, so events wait for it. */
  async #history(wire) {
    this.#keepChatMessages();
    for (const channelId of this.#chatChannels()) {
      if (this.#loaded.has(channelId)) continue;
      this.#loaded.add(channelId);
      try {
        const history = await wire.rpc("message.history", { channelId });
        if (this.#wire !== wire || !this.#loaded.has(channelId)) continue;
        const entries = new Map(history.reverse().map((message) => [message.id, message]));
        const others = [];
        for (const message of this.view.messages) {
          if (message.channelId === channelId) entries.set(message.id, message);
          else others.push(message);
        }
        this.#show({ messages: [...others, ...[...entries.values()].slice(-channelMessageLimit)] });
      } catch {}
    }
  }

  viewChannel(connectionId, channelId) {
    return this.run(async (wire) => {
      if (this.connectionId !== connectionId || this.#viewed === channelId) return;
      await wire.rpc("channel.view", { channelId });
      this.#viewed = channelId;
      await this.#history(wire);
    });
  }

  join(channelId, password) {
    return this.run(async (wire) => {
      const room = { channelId, password: password ?? undefined };
      const snapshot = await wire.rpc("channel.join", room);
      this.#room = room;
      if (this.#replaceSnapshot(snapshot)) await this.#history(wire);
    });
  }

  leave() {
    return this.#enqueue(async () => {
      if (this.#wire && this.view.phase === "online" && this.channelId) {
        this.#replaceSnapshot(await this.#wire.rpc("channel.leave"));
      }
      this.#room = undefined;
    });
  }

  saveChannel(payload) {
    return this.run(async (wire) => {
      const { state } = await wire.rpc(typeof payload?.channelId === "string" ? "channel.edit" : "channel.create", payload);
      this.#replaceSnapshot(state);
    });
  }

  setPresence(values) {
    return this.run(async (wire) => {
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value != null));
      const member = await wire.rpc("presence.set", fields);
      Object.assign(this.#presence, fields);
      if (this.channelId) this.#updateMember(member);
    });
  }

  #updateMember(member, left = false) {
    const snapshot = this.view.snapshot;
    const members = snapshot.members.filter(({ connectionId }) => connectionId !== member.connectionId);
    if (!left) members.push(member);
    this.#show({ snapshot: { ...snapshot, members } });
  }

  #addDirect(message) {
    if (!this.view.directMessages.some((known) => isSameDirectMessage(known, message))) {
      this.#show({ directMessages: [...this.view.directMessages, message].slice(-directMessageLimit) });
    }
  }

  async #receiveQueued(wire, accountId) {
    try {
      for (let page = 0; page < 2; page++) {
        const queued = await wire.rpc("direct.pending");
        if (this.#wire !== wire) return;
        const mine = queued.filter(({ recipientId }) => recipientId === accountId);
        if (!mine.length) return;
        for (const message of mine) this.#addDirect(message);
        await wire.rpc("direct.ack", { ids: mine.map(({ id }) => id) });
        if (queued.length < 100) return;
      }
    } catch {}
  }

  #showSpeaking() {
    this.#show({ speaking: Array.from(this.#speaking, (producerId) => this.#audioSources.get(producerId)) });
  }

  #reviseMessages(channelId) {
    const revisions = this.view.messageRevisions;
    return channelId ? { ...revisions, [channelId]: (revisions[channelId] ?? 0) + 1 } : revisions;
  }

  async #event(wire, { type, payload }) {
    const { snapshot, messages, directMessages } = this.view;
    const sameRoom = payload?.channelId === undefined || payload.channelId === snapshot.channelId;
    if (mediaEvents.has(type) && snapshot.channelId) {
      this.emit("korero:media", {
        origin: this.server.origin, connectionId: snapshot.connectionId, channelId: snapshot.channelId, event: { type, payload },
      });
    }
    if (snapshotEvents.has(type)) {
      const current = await wire.rpc("state.get");
      if (type === "channel.changed" && current.channelId !== snapshot.channelId) {
        this.#room = current.channelId ? { channelId: current.channelId } : undefined;
      }
      if (this.#replaceSnapshot(current)) await this.#history(wire);
    } else if (type === "channel.viewEnded" && this.#viewed === payload.channelId) {
      this.#viewed = null;
      this.#keepChatMessages();
    } else if (type === "channel.member" || type === "channel.voiceActivity") {
      const { channelId, connectionId } = payload;
      if (!snapshot.channels.some(({ id }) => id === channelId)) return;
      const updateActivity = (members) => members.map((member) => member.connectionId === connectionId
        ? { ...member, speaking: payload.speaking } : member);
      const tree = snapshot.channelMembers ?? {};
      const treeMembers = tree[channelId] ?? [];
      const members = type === "channel.voiceActivity" ? updateActivity(treeMembers)
        : [...treeMembers.filter((member) => member.connectionId !== connectionId), ...(payload.left ? [] : [payload])];
      this.#show({ snapshot: { ...snapshot, channelMembers: { ...tree, [channelId]: members },
        members: sameRoom && type === "channel.voiceActivity" ? updateActivity(snapshot.members) : snapshot.members } });
    } else if (sameRoom && ["channel.userJoined", "channel.userChanged", "channel.userLeft"].includes(type)) {
      this.#updateMember(payload, type === "channel.userLeft");
    } else if (type === "message.created" && this.#chatChannels().has(payload.channelId) && !messages.some(({ id }) => id === payload.id)) {
      const inChannel = messages.filter(({ channelId }) => channelId === payload.channelId);
      const oldest = new Set(inChannel.slice(0, Math.max(0, inChannel.length + 1 - channelMessageLimit)));
      this.#show({ messages: [...messages.filter((message) => !oldest.has(message)), payload] });
    } else if (type === "message.edited") {
      this.#show({ messages: messages.map((message) => message.id === payload.messageId
        ? { ...message, text: payload.text, html: payload.html, editedAt: payload.editedAt,
          ...(payload.mentions ? { mentions: payload.mentions.accounts.length || payload.mentions.roles.length ? payload.mentions : undefined } : {}) } : message),
        messageRevisions: this.#reviseMessages(payload.channelId) });
    } else if (type === "message.deleted") {
      this.#show({ messages: messages.filter(({ id }) => id !== payload.messageId), messageRevisions: this.#reviseMessages(payload.channelId) });
    } else if (type === "message.pinChanged") {
      this.#show({ messages: messages.map((message) => message.id === payload.messageId ? { ...message, pinnedAt: payload.pinnedAt } : message),
        messageRevisions: this.#reviseMessages(payload.channelId) });
    } else if (type === "message.reactionsChanged") {
      const mine = payload.accountId === snapshot.account.id;
      this.#show({ messages: messages.map((message) => message.id === payload.messageId
        ? { ...message, reactions: applyReaction(message.reactions, payload, mine) } : message),
        messageRevisions: this.#reviseMessages(payload.channelId) });
    } else if (type === "message.mentioned") {
      this.#show({ lastMention: payload });
    } else if (type === "direct.poked" && payload.recipientId === snapshot.account.id) {
      this.#show({ lastPoke: payload });
    } else if (type.startsWith("direct.") && [payload?.senderId, payload?.recipientId].includes(snapshot.account.id)) {
      const matches = (message) => isSameDirectMessage(message, payload);
      if (type === "direct.created") this.#addDirect(payload);
      if (type === "direct.edited") {
        const known = directMessages.find(matches);
        if (!known && payload.createdAt === undefined) return;
        const { nonce, ciphertext, signature, editedAt } = payload;
        const edited = known ? { ...known, nonce, ciphertext, signature, editedAt } : payload;
        this.#show({ directMessages: known ? directMessages.map((message) => matches(message) ? edited : message)
          : [...directMessages, edited].slice(-directMessageLimit) }, { type: "edit", message: edited });
      }
      if (type === "direct.deleted") this.#show({
        directMessages: directMessages.filter((message) => !matches(message)),
      }, { type: "delete", message: payload });
    } else if (sameRoom && /^media\.(screen|camera)(Available|Closed)$/.test(type)) {
      const source = type.startsWith("media.screen") ? "screens" : "cameras";
      const shares = (snapshot[source] ?? []).filter(({ producerId }) => producerId !== payload.producerId);
      if (type.endsWith("Available")) shares.push(payload);
      this.#show({ snapshot: { ...snapshot, [source]: shares } });
    } else if (sameRoom && type === "media.producerAvailable" && payload.connectionId !== snapshot.connectionId) {
      this.#audioSources.set(payload.producerId, payload.connectionId);
      if (payload.whisperFrom) {
        const whispers = (snapshot.whispers ?? []).filter(({ producerId }) => producerId !== payload.producerId);
        this.#show({ snapshot: { ...snapshot, whispers: [...whispers, { producerId: payload.producerId, from: payload.whisperFrom }] } });
      }
    } else if (sameRoom && (type === "media.producerClosed" || type === "media.consumerClosed")) {
      this.#audioSources.delete(payload.producerId);
      if (this.#speaking.delete(payload.producerId)) this.#showSpeaking();
      if (snapshot.whispers?.length) this.#show({
        snapshot: { ...snapshot, whispers: snapshot.whispers.filter(({ producerId }) => producerId !== payload.producerId) },
      });
    } else if (type === "media.speaking" && snapshot.members.some(({ speaking }) => speaking === undefined)) {
      // Older servers use producer IDs for speaking updates.
      const { producerId, speaking } = payload;
      if (speaking && !this.#audioSources.has(producerId)) {
        for (const source of await wire.rpc("media.producers")) this.#audioSources.set(source.producerId, source.connectionId);
      }
      if (speaking && this.#audioSources.has(producerId)) this.#speaking.add(producerId);
      else this.#speaking.delete(producerId);
      this.#showSpeaking();
    } else if (sameRoom && type === "media.reset") {
      this.#audioSources.clear();
      this.#speaking.clear();
      this.#show({ snapshot: { ...snapshot, whispers: [], screens: [], cameras: [] }, speaking: [] });
    }
  }
}
