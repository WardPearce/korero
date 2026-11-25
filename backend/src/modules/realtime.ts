import { and, desc, eq, gt, gte, inArray, lt, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, type Config } from "../config";
import { atomicWrite } from "../security/files";
import { audit, LOBBY, permissions, roles, type Permission, type Role, type Store } from "../database";
import { accounts, accountRoles, auditEvents, bans, channelOverrides, channels, hearingRestrictions, messages, rolePermissions, rolesTable, settings, speakingRestrictions } from "../database/schema";
import { decode, type Request } from "../protocol";
import { errorResponse, fail, ProtocolError, RateLimit } from "../security/errors";
import { Auth, isBanned, type Account, type Session } from "./auth";
import { Media } from "./media";

type Channel = typeof channels.$inferSelect;
type Socket = { sendText(data: string): number; close(code?: number, reason?: string): unknown; terminate(): unknown };
type Peer = { id: string; socket: Socket; session: Session | null; account: Account | null; channelId: string | null; membershipEpoch: number;
  afk: boolean; afkMessage: string;
  muted: boolean; deafened: boolean; adminMuted: boolean; adminDeafened: boolean; deadline: number; closed: boolean; pending: number;
  queue: Promise<void>; latest: number; replayBytes: number; replies: Map<number, { digest: string; reply: string; size: number }> };
type Destination = { channelId?: string; accountId?: string };
type ChannelChange = Extract<Request, { type: "channel.edit" | "channel.create" }>["payload"];
const compareChannels = (a: Channel, b: Channel) =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const replyWindow = 16;
const replayByteLimit = 262144;

function imageUrl(value: string) {
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.href.length > 512) fail("INVALID_REQUEST");
  return url.href;
}

export class Realtime {
  private readonly peers = new Map<string, Peer>();
  private readonly connected = new Map<string, Peer>();
  private readonly online = new Map<string, Set<Peer>>();
  private readonly memberships = new Map<string, Set<Peer>>();
  private readonly catalog = new Map<string, Channel>();
  private readonly roleGrants = new Map<Role, Set<Permission>>();
  private readonly customRoles = new Map<Role, number>();
  private readonly overrides = new Map<string, Map<string, boolean>>();
  private readonly requestRate: RateLimit;
  private readonly messageRate: RateLimit;
  private readonly mediaRate: RateLimit;
  private readonly iceRate: RateLimit;
  private readonly joinRate: RateLimit;
  private readonly timer: ReturnType<typeof setInterval>;
  private tick = 0;
  private pending = 0;
  private passwordWork = 0;
  private savingConfiguration = false;
  bannerImageUrl: string | null;

  constructor(private readonly db: Store, private readonly auth: Auth, private readonly media: Media, private readonly config: Config) {
    this.bannerImageUrl = db.select().from(settings).where(eq(settings.key, "bannerImageUrl")).get()?.value ?? null;
    db.delete(channels).where(eq(channels.temporary, true)).run();
    for (const channel of db.select().from(channels).all()) this.catalog.set(channel.id, channel);
    for (const { name, rank } of db.select().from(rolesTable).where(lt(rolesTable.rank, 0)).orderBy(desc(rolesTable.rank)).all()) {
      this.customRoles.set(name, rank);
    }
    for (const { role, permission } of db.select().from(rolePermissions).all()) {
      const grants = this.roleGrants.get(role) ?? new Set<Permission>();
      grants.add(permission as Permission);
      this.roleGrants.set(role, grants);
    }
    for (const { channelId, role, permission, allow } of db.select().from(channelOverrides).all()) {
      const overrides = this.overrides.get(channelId) ?? new Map();
      overrides.set(`${role}/${permission}`, allow);
      this.overrides.set(channelId, overrides);
    }
    this.requestRate = new RateLimit(config.limits.websocket_requests_per_minute);
    this.mediaRate = new RateLimit(config.limits.media_per_minute);
    this.iceRate = new RateLimit(config.limits.ice_restarts_per_minute);
    this.joinRate = new RateLimit(12);
    this.messageRate = new RateLimit(config.messaging.per_minute);
    this.timer = setInterval(() => this.sweep(), 1000);
    auth.onRevoked = (ids) => {
      for (const peer of this.peers.values()) if (peer.session && ids.has(peer.session.id)) this.disconnect(peer, 4401, "Session revoked");
    };
    auth.onAccountChanged = (id) => this.accountChanged(id);
    media.event = (channelId, type, payload) => {
      if (type === "channel.voiceActivity") this.broadcastVisible(channelId, type, payload);
      else this.broadcast(this.memberships.get(channelId), type, payload);
    };
    media.peerEvent = (peerId, type, payload) => {
      const peer = this.connected.get(peerId);
      if (peer) this.event(peer, type, payload);
    };
  }

  open(id: string, socket: Socket) {
    if (this.pending >= this.config.limits.pending_connections) { socket.close(4429, "Too many pending connections"); return; }
    this.pending++;
    this.peers.set(id, { id: randomUUID(), socket, session: null, account: null, channelId: null, membershipEpoch: 0,
      afk: false, afkMessage: "",
      muted: false, deafened: false, adminMuted: false, adminDeafened: false, deadline: Date.now() + 5000, closed: false,
      pending: 0, queue: Promise.resolve(), latest: 0, replayBytes: 0, replies: new Map() });
  }
  receive(id: string, message: unknown) {
    const peer = this.peers.get(id);
    if (!peer || peer.closed) return;
    peer.pending++;
    if (peer.pending > this.config.limits.websocket_pending) { this.disconnect(peer, 4429, "Too many pending requests"); return; }
    peer.queue = peer.queue.then(async () => {
      try { if (!peer.closed) await this.respond(peer, message); }
      finally { peer.pending--; }
    }).catch(() => this.disconnect(peer, 1011, "Internal server error"));
  }
  closed(id: string) {
    const peer = this.peers.get(id);
    if (peer) this.disconnect(peer);
    this.peers.delete(id);
  }
  private disconnect(peer: Peer, code?: number, reason?: string) {
    if (peer.closed) return;
    peer.closed = true;
    if (peer.account) {
      this.connected.delete(peer.id);
      const group = this.online.get(peer.account.id)!;
      group.delete(peer);
      if (!group.size) this.online.delete(peer.account.id);
      this.leave(peer);
      if (!group.size) {
        this.broadcastAll("presence.offline", { accountId: peer.account.id });
      } else this.presenceAccount(peer.account.id);
    } else this.pending--;
    if (code) peer.socket.close(code, reason);
  }
  private sweep() {
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (peer.closed) continue;
      if (!peer.account && peer.deadline <= now) this.disconnect(peer, 4401, "Authentication timeout");
      else if (peer.account) {
        if (peer.session!.expiresAt <= now) {
          const session = this.auth.getSession(peer.session!.id);
          if (!session) this.disconnect(peer, 4401, "Session expired");
          else peer.session = session;
        }
      }
    }
    this.tick++;
    const persistent = this.tick === 60;
    this.auth.sweep(now, persistent);
    if (persistent) {
      this.tick = 0;
      const expired = this.db.select({ id: messages.id }).from(messages).where(lt(messages.createdAt, this.retentionCutoff())).limit(1000);
      this.db.delete(messages).where(inArray(messages.id, expired)).run();
    }
  }
  async close() {
    clearInterval(this.timer);
    for (const peer of this.peers.values()) {
      this.disconnect(peer, 1001, "Server shutdown");
      peer.socket.terminate();
    }
    await Promise.all([...this.peers.values()].map(({ queue }) => queue));
    this.peers.clear();
  }

  private async respond(peer: Peer, message: unknown) {
    const candidate = typeof message === "object" && message !== null && "id" in message ? message.id : null;
    let id = typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 0;
    let digest: string | undefined;
    let response: unknown;
    try {
      this.requestRate.take(peer.account?.id ?? peer.id);
      const request = decode(message);
      id = request.id;
      digest = createHash("sha256").update(JSON.stringify(message)).digest("hex");
      const cached = peer.replies.get(id);
      if (cached?.digest === digest) { this.send(peer, cached.reply); return; }
      if (id <= peer.latest) fail("CONFLICT");
      peer.latest = id;
      response = { version: 1, id, type: "response", success: true, payload: await this.dispatch(peer, request) };
    } catch (error) {
      response = { version: 1, id, type: "response", success: false, error: errorResponse(error).error };
    }
    const serialized = JSON.stringify(response);
    const size = Buffer.byteLength(serialized);
    if (digest && !peer.replies.has(id) && peer.latest === id && size <= replayByteLimit) {
      peer.replies.set(id, { digest, reply: serialized, size });
      peer.replayBytes += size;
      while (peer.replies.size > replyWindow || peer.replayBytes > replayByteLimit) {
        const oldest = peer.replies.keys().next().value!;
        peer.replayBytes -= peer.replies.get(oldest)!.size;
        peer.replies.delete(oldest);
      }
    }
    this.send(peer, serialized);
    if (!peer.account) this.disconnect(peer, 4401, "Authentication required");
  }
  private send(peer: Peer, text: string) {
    if (!peer.closed && peer.socket.sendText(text) === 0) {
      this.disconnect(peer);
      peer.socket.terminate();
    }
  }
  private event(peer: Peer, type: string, payload: unknown) {
    this.send(peer, JSON.stringify({ version: 1, type, payload }));
  }
  private broadcast(peers: Iterable<Peer> | undefined, type: string, payload: unknown, except?: Peer) {
    if (!peers) return;
    const text = JSON.stringify({ version: 1, type, payload });
    for (const peer of [...peers]) if (peer !== except) this.send(peer, text);
  }
  private broadcastVisible(channelId: string, type: string, payload: unknown) {
    const channel = this.catalog.get(channelId);
    if (!channel) return;
    for (const peers of this.online.values()) {
      if (this.allowed(peers.values().next().value!.account!, "join", channel)) this.broadcast(peers, type, payload);
    }
  }
  private treeMember(peer: Peer, channelId: string) {
    return { ...this.member(peer), speaking: this.media.isSpeaking(channelId, peer.id) };
  }
  private memberChanged(peer: Peer) {
    if (!peer.channelId) return;
    const channelId = peer.channelId;
    this.broadcast(this.memberships.get(channelId), "channel.userChanged", { channelId, ...this.member(peer) });
    this.broadcastVisible(channelId, "channel.member", { channelId, ...this.treeMember(peer, channelId) });
  }
  private broadcastAll(type: string, payload: unknown) {
    this.broadcast([...this.online.values()].flatMap((set) => [...set]), type, payload);
  }
  private presenceAccount(accountId: string, except?: Peer) {
    const members = this.online.get(accountId);
    if (!members?.size) return;
    const { id, displayName } = members.values().next().value!.account!;
    this.broadcast([...this.online.values()].flatMap((set) => [...set]), "presence.changed",
      { accountId: id, displayName, connections: members.size }, except);
  }
  private accountChanged(id: string) {
    const peers = this.online.get(id);
    if (!peers?.size) return;
    const account = this.auth.account(id);
    for (const peer of [...peers]) {
      peer.account = account;
      this.recheck(peer);
      this.memberChanged(peer);
    }
    this.presenceAccount(id);
    this.broadcast(peers, "state.invalidated", {});
  }
  private verify(peer: Peer) {
    if (peer.closed || !peer.session || !peer.account) fail("AUTH_FAILED");
    const session = this.auth.getSession(peer.session.id);
    if (!session || isBanned(this.db, session.accountId)) {
      this.disconnect(peer, 4401, "Session unavailable");
      fail("AUTH_FAILED");
    }
    peer.session = session;
    this.auth.touch(session);
    return peer.account;
  }
  private allowed(account: Account, permission: Permission, channel?: Channel) {
    if (account.role === "Owner") return true;
    let current = channel;
    while (current) {
      const override = this.overrides.get(current.id)?.get(`${account.role}/${permission}`);
      if (override !== undefined) return override;
      current = current.parentId ? this.catalog.get(current.parentId) : undefined;
    }
    return this.roleGrants.get(account.role)?.has(permission) ?? false;
  }
  private require(account: Account, permission: Permission, channel?: Channel) {
    if (!this.allowed(account, permission, channel)) fail("FORBIDDEN");
  }
  authorize(accountId: string, permission: Permission) {
    const account = this.auth.account(accountId);
    this.require(account, permission);
    return account;
  }
  private rank(role: Role) {
    // Custom roles share a tier between Moderator and Administrator.
    if (this.customRoles.has(role)) return 2.5;
    const rank = roles.findIndex((name) => name === role);
    return rank < 0 ? fail("NOT_FOUND") : rank;
  }
  private canAssign(actor: Account, role: Role) {
    return this.rank(role) < this.rank(actor.role) &&
      [...this.roleGrants.get(role) ?? []].every((permission) => this.allowed(actor, permission));
  }
  private lowerRoles(actor: Account) {
    return [...roles, ...this.customRoles.keys()].filter((role) => this.rank(role) < this.rank(actor.role));
  }
  listAccounts(accountId: string, after?: string) {
    const actor = this.authorize(accountId, "manageRoles");
    const rows = this.db.select({ id: accounts.id, displayName: accounts.displayName, role: accountRoles.role })
      .from(accounts).innerJoin(accountRoles, eq(accounts.id, accountRoles.accountId))
      .where(after ? gt(accounts.id, after) : undefined).orderBy(accounts.id).limit(51).all();
    const accountsPage = rows.slice(0, 50).map((account) => ({
      ...account, editable: account.id !== actor.id && this.rank(account.role) < this.rank(actor.role),
    }));
    const canDefineRoles = this.rank(actor.role) >= this.rank("Administrator");
    const customRoles = [...this.customRoles.keys()];
    return { accounts: accountsPage, next: rows.length > 50 ? accountsPage.at(-1)!.id : null,
      roles: this.lowerRoles(actor).filter((role) => this.canAssign(actor, role)),
      customRoles: canDefineRoles ? customRoles.map((name) => ({ name, permissions: [...this.roleGrants.get(name) ?? []] })) : [],
      assignablePermissions: canDefineRoles ? permissions.filter((permission) => this.allowed(actor, permission)) : [],
      canDefineRoles };
  }
  setRole(actor: Account, accountId: string, role: Role) {
    this.require(actor, "manageRoles");
    const target = this.auth.account(accountId);
    this.subordinate(actor, target);
    if (!this.canAssign(actor, role)) fail("FORBIDDEN");
    if (target.role === role) return;
    this.db.transaction((tx) => {
      tx.update(accountRoles).set({ role }).where(eq(accountRoles.accountId, accountId)).run();
      audit(tx, actor.id, "role.changed", accountId);
    }, { behavior: "immediate" });
    this.accountChanged(accountId);
  }
  defineRole(accountId: string, name: Role, grants: Permission[], create: boolean) {
    const actor = this.authorize(accountId, "manageRoles");
    if (this.rank(actor.role) < this.rank("Administrator")) fail("FORBIDDEN");
    const existing = this.customRoles.get(name);
    if (create) {
      if ([...roles, ...this.customRoles.keys()].some((role) => role.toLowerCase() === name.toLowerCase())) {
        throw new ProtocolError("CONFLICT", "A role with that name already exists.");
      }
    } else if (existing === undefined) {
      fail("NOT_FOUND");
    }
    const unique = new Set(grants);
    for (const permission of unique) this.require(actor, permission);
    // Negative database ranks distinguish custom roles from the fixed built-in ranks.
    const rank = existing ?? Math.min(0, ...this.customRoles.values()) - 1;
    this.db.transaction((tx) => {
      if (create) tx.insert(rolesTable).values({ name, rank }).run();
      else tx.delete(rolePermissions).where(eq(rolePermissions.role, name)).run();
      if (unique.size) tx.insert(rolePermissions).values([...unique].map((permission) => ({ role: name, permission }))).run();
      audit(tx, actor.id, create ? "role.created" : "role.permissions_changed", name);
    }, { behavior: "immediate" });
    this.customRoles.set(name, rank);
    this.roleGrants.set(name, unique);
    this.recheckAll();
    return { name, permissions: [...unique] };
  }
  setBanner(accountId: string, url: string | null) {
    const actor = this.authorize(accountId, "manageSettings");
    const bannerImageUrl = url === null ? null : imageUrl(url);
    this.db.transaction((tx) => {
      const key = "bannerImageUrl";
      if (bannerImageUrl === null) tx.delete(settings).where(eq(settings.key, key)).run();
      else tx.insert(settings).values({ key, value: bannerImageUrl })
        .onConflictDoUpdate({ target: settings.key, set: { value: bannerImageUrl } }).run();
      audit(tx, actor.id, "server.banner_changed", null);
    }, { behavior: "immediate" });
    this.bannerImageUrl = bannerImageUrl;
    this.broadcastAll("state.invalidated", {});
    return { bannerImageUrl };
  }
  async configuration(authorize: () => Account) {
    authorize();
    const file = Bun.file(this.config.file);
    if (file.size > 65536) throw new ProtocolError("LIMIT", "The configuration file is too large to edit here.");
    const toml = await file.text();
    authorize();
    return {
      toml, revision: createHash("sha256").update(toml).digest("hex"),
      overrides: ["name", "registration"].filter((key) => this.db.select().from(settings).where(eq(settings.key, key)).get()),
    };
  }
  async saveConfiguration(authorize: () => Account, toml: string, revision: string) {
    authorize();
    if (this.savingConfiguration) fail("CONFLICT");
    this.savingConfiguration = true;
    try {
      const previous = await this.configuration(authorize);
      if (previous.revision !== revision) throw new ProtocolError("CONFLICT", "The file changed. Reload it before saving.");
      if (previous.toml === toml) return previous;
      try {
        const old = Bun.TOML.parse(previous.toml) as { storage?: { directory?: string } };
        const next = Bun.TOML.parse(toml) as typeof old;
        if (old.storage?.directory !== next.storage?.directory) {
          throw new Error("Change storage.directory on the host.");
        }
        await loadConfig({ file: this.config.file, directory: this.config.directory, source: toml });
      } catch (error) {
        const message = error instanceof SyntaxError ? "Invalid TOML." : (error as Error).message;
        throw new ProtocolError("INVALID_REQUEST", message);
      }
      const actor = authorize();
      await atomicWrite(this.config.file, toml);
      this.db.transaction((tx) => {
        tx.delete(settings).where(inArray(settings.key, ["name", "registration"])).run();
        audit(tx, actor.id, "server.configuration_changed", null);
      }, { behavior: "immediate" });
      return { toml, revision: createHash("sha256").update(toml).digest("hex"), overrides: [] };
    } finally { this.savingConfiguration = false; }
  }
  private subordinate(actor: Account, target: Account) {
    if (target.id === actor.id || this.rank(actor.role) <= this.rank(target.role)) fail("FORBIDDEN");
  }
  private channel(id: string) { return this.catalog.get(id) ?? fail("NOT_FOUND"); }
  private channelMember(peer: Peer) { return peer.channelId ? this.channel(peer.channelId) : fail("FORBIDDEN"); }
  private peer(id: string) {
    return this.connected.get(id) ?? fail("NOT_FOUND");
  }
  private member(peer: Peer) {
    return { connectionId: peer.id, accountId: peer.account!.id, displayName: peer.account!.displayName,
      afk: peer.afk, afkMessage: peer.afk ? peer.afkMessage : "",
      role: peer.account!.role, muted: peer.muted || peer.afk, deafened: peer.deafened || peer.afk, adminMuted: peer.adminMuted,
      adminDeafened: peer.adminDeafened };
  }
  private snapshot(peer: Peer) {
    const account = peer.account!;
    const visible = [...this.catalog.values()].filter((channel) => this.allowed(account, "join", channel));
    const visibleIds = new Set(visible.map(({ id }) => id));
    const lowerRoles = this.lowerRoles(account);
    return { connectionId: peer.id, account, channelId: peer.channelId,
      channels: visible.sort(compareChannels).map(
        (channel) => {
          const { id, name, parentId, description, position, capacity, temporary, passwordHash, backgroundImageUrl } = channel;
          return { id, name, parentId: parentId && visibleIds.has(parentId) ? parentId : null, description, position, capacity,
            temporary, passwordRequired: !!passwordHash, backgroundImageUrl, canEdit: this.allowed(account, "editChannels", channel),
            canSetPassword: id !== LOBBY && this.allowed(account, "editChannels", channel),
            canMute: this.allowed(account, "mute") && this.allowed(account, "mute", channel) };
        }),
      presence: [...this.online.values()].map((connections) => {
        const { id, displayName } = connections.values().next().value!.account!;
        return { accountId: id, displayName, connections: connections.size };
      }),
      members: peer.channelId ? [...(this.memberships.get(peer.channelId) ?? [])].map((member) => this.member(member)) : [],
      channelMembers: Object.fromEntries(visible.filter(({ id }) => this.memberships.has(id)).map(({ id }) =>
        [id, [...this.memberships.get(id)!].map((member) => this.treeMember(member, id))])),
      serverPermissions: [...this.roleGrants.get(account.role) ?? []],
      lowerRoles,
      assignableRoles: this.allowed(account, "manageRoles") ? lowerRoles.filter((role) => this.canAssign(account, role)) : [],
      bannerImageUrl: this.bannerImageUrl,
      canReorderChannels: this.allowed(account, "editChannels"),
    };
  }
  private leave(peer: Peer) {
    const channelId = peer.channelId;
    if (!channelId) return;
    peer.channelId = null;
    peer.membershipEpoch++;
    const members = this.memberships.get(channelId);
    members?.delete(peer);
    this.broadcastVisible(channelId, "channel.member", { channelId, connectionId: peer.id, left: true });
    this.media.detach(peer.id);
    this.broadcast(members, "channel.userLeft", { channelId, connectionId: peer.id, accountId: peer.account!.id });
    if (!members?.size) {
      this.memberships.delete(channelId);
      this.media.releaseRoom(channelId);
      if (this.catalog.get(channelId)?.temporary) this.removeChannel(channelId);
    }
  }
  private join(peer: Peer, channel: Channel) {
    if (peer.channelId === channel.id) return;
    const members = this.memberships.get(channel.id) ?? new Set<Peer>();
    if (members.size >= Math.min(channel.capacity ?? Infinity, this.config.limits.users_per_channel)) fail("LIMIT");
    this.leave(peer);
    if (peer.closed || !this.catalog.has(channel.id)) fail("CONFLICT");
    peer.channelId = channel.id;
    peer.membershipEpoch++;
    members.add(peer);
    this.memberships.set(channel.id, members);
    this.broadcastVisible(channel.id, "channel.member", { channelId: channel.id, ...this.treeMember(peer, channel.id) });
    this.broadcast(members, "channel.userJoined", { channelId: channel.id, ...this.member(peer) }, peer);
  }
  private recheck(peer: Peer) {
    if (!peer.channelId || peer.closed) return;
    const channel = this.channel(peer.channelId);
    if (!this.allowed(peer.account!, "join", channel)) {
      this.leave(peer);
      this.event(peer, "channel.changed", { channelId: null });
    } else if (!this.allowed(peer.account!, "speak", channel)) this.media.stopSending(peer.id);
  }
  private recheckAll() {
    for (const group of this.online.values()) for (const peer of [...group]) this.recheck(peer);
    this.broadcastAll("state.invalidated", {});
  }
  private removeChannel(id: string, actor?: string) {
    this.db.transaction((tx) => {
      tx.delete(channels).where(eq(channels.id, id)).run();
      if (actor) audit(tx, actor, "channel.deleted", id);
    }, { behavior: "immediate" });
    this.catalog.delete(id);
    this.overrides.delete(id);
    for (const peer of [...(this.memberships.get(id) ?? [])]) {
      this.leave(peer);
      this.event(peer, "channel.changed", { channelId: null });
    }
    this.media.releaseRoom(id);
    this.broadcastAll("state.invalidated", {});
  }

  private async password<T>(run: () => Promise<T>) {
    if (this.passwordWork >= 2) fail("RATE_LIMITED");
    this.passwordWork++;
    try { return await run(); } finally { this.passwordWork--; }
  }
  reorderChannel(accountId: string, channelId: string, targetId: string, placement: "before" | "after") {
    const actor = this.authorize(accountId, "editChannels");
    const source = this.channel(channelId);
    const target = this.channel(targetId);
    this.require(actor, "join", source);
    this.require(actor, "join", target);
    this.require(actor, "editChannels", source);
    this.require(actor, "editChannels", target);
    if (source.parentId !== target.parentId) fail("CONFLICT");
    if (source === target) return {};
    const siblings = [...this.catalog.values()].filter((channel) => channel.parentId === source.parentId && channel !== source)
      .sort(compareChannels);
    siblings.splice(siblings.indexOf(target) + (placement === "after" ? 1 : 0), 0, source);
    const changes = siblings.flatMap((channel, position) => channel.position === position ? [] : [{ ...channel, position }]);
    if (!changes.length) return {};
    this.db.transaction((tx) => {
      for (const { id, position } of changes) tx.update(channels).set({ position }).where(eq(channels.id, id)).run();
      audit(tx, actor.id, "channel.reordered", source.id);
    }, { behavior: "immediate" });
    for (const channel of changes) this.catalog.set(channel.id, channel);
    this.broadcastAll("state.invalidated", {});
    return {};
  }
  private async changeChannel(peer: Peer, payload: ChannelChange) {
    const id = "channelId" in payload ? payload.channelId : randomUUID();
    const current = "channelId" in payload ? this.channel(id) : undefined;
    const permission = current ? "editChannels" : "createChannels";
    const authorize = () => {
      const actor = this.verify(peer);
      if (current && this.channel(current.id) !== current) fail("CONFLICT");
      const parentId = payload.parentId !== undefined ? payload.parentId : current?.parentId ?? null;
      const parent = parentId ? this.channel(parentId) : undefined;
      this.require(actor, permission, current ?? parent);
      if (parent && current?.parentId !== parentId) this.require(actor, permission, parent);
      if (current?.id === LOBBY && (parent || payload.password || payload.capacity !== undefined && payload.capacity !== null)) fail("FORBIDDEN");
      if (!current && this.catalog.size >= this.config.limits.max_channels) fail("LIMIT");
      if (parent?.temporary) fail("CONFLICT");
      let ancestor = parent;
      for (let depth = 0; ancestor; depth++) {
        if (ancestor.id === id || depth >= 15) fail("CONFLICT");
        ancestor = ancestor.parentId ? this.channel(ancestor.parentId) : undefined;
      }
      // Moving a subtree must also preserve the maximum depth of its descendants.
      if (current && current.parentId !== parentId) {
        for (const candidate of this.catalog.values()) {
          let child = candidate;
          let length = 0;
          while (child.parentId && child.id !== id) { child = this.channel(child.parentId); length++; }
          if (child.id !== id) continue;
          for (let node = parent; node; node = node.parentId ? this.channel(node.parentId) : undefined) length++;
          if (length >= 16) fail("CONFLICT");
        }
      }
      return { actor, parentId };
    };
    authorize();
    const image = payload.backgroundImageUrl;
    const backgroundImageUrl = image === undefined ? current?.backgroundImageUrl ?? null : image === null ? null : imageUrl(image);
    const passwordHash = payload.password === undefined ? current?.passwordHash ?? null : payload.password === null ? null :
      await this.password(() => Bun.password.hash(payload.password!, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }));
    const { actor, parentId } = authorize();
    const channel = {
      id, parentId, name: payload.name?.trim() ?? current!.name, description: payload.description ?? current?.description ?? "",
      position: payload.position ?? current?.position ?? 0, capacity: payload.capacity !== undefined ? payload.capacity : current?.capacity ?? null,
      temporary: "temporary" in payload ? !!payload.temporary : current?.temporary ?? false, passwordHash, backgroundImageUrl,
    };
    this.db.transaction((tx) => {
      tx.insert(channels).values(channel).onConflictDoUpdate({ target: channels.id, set: channel }).run();
      audit(tx, actor.id, current ? "channel.edited" : "channel.created", id);
    }, { behavior: "immediate" });
    this.catalog.set(id, channel);
    if (channel.temporary && !current) {
      try { this.require(actor, "join", channel); this.join(peer, channel); } catch (error) { this.removeChannel(id); throw error; }
    }
    this.recheckAll();
    return { channelId: id, state: this.snapshot(peer) };
  }

  private destination(peer: Peer, target: Destination) {
    if (!!target.accountId === !!target.channelId) fail("INVALID_REQUEST");
    const actor = peer.account!;
    if (target.channelId) {
      const channel = this.channel(target.channelId);
      this.require(actor, "join", channel);
      this.require(actor, "text", channel);
      if (peer.channelId !== channel.id) fail("FORBIDDEN");
      return { channelId: channel.id, recipientId: null };
    }
    this.require(actor, "text");
    const recipient = target.accountId!;
    if (isBanned(this.db, recipient) || !this.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, recipient)).get()) fail("NOT_FOUND");
    return { channelId: null, recipientId: recipient };
  }
  private retentionCutoff() { return Date.now() - this.config.messaging.retention_hours * 3600000; }
  private history(peer: Peer, payload: Destination & { before?: number }) {
    const { channelId, recipientId } = this.destination(peer, payload);
    if (!this.config.messaging.persistence) return [];
    const actor = peer.account!.id;
    const scope = channelId ? eq(messages.channelId, channelId) :
      or(and(eq(messages.senderId, actor), eq(messages.recipientId, recipientId!)),
        and(eq(messages.senderId, recipientId!), eq(messages.recipientId, actor)));
    return this.db.select().from(messages).where(and(scope, gte(messages.createdAt, this.retentionCutoff()),
      payload.before === undefined ? undefined : lt(messages.createdAt, payload.before)))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(100).all();
  }
  private sendMessage(peer: Peer, payload: Destination & { text: string }) {
    this.messageRate.take(peer.account!.id);
    if (payload.text.length > this.config.messaging.max_length || !payload.text.trim()) fail("INVALID_REQUEST");
    const destination = this.destination(peer, payload);
    const message = { id: randomUUID(), ...destination, senderId: peer.account!.id, createdAt: Date.now(), text: payload.text };
    if (this.config.messaging.persistence) this.db.insert(messages).values(message).run();
    if (message.channelId) {
      const channel = this.channel(message.channelId);
      this.broadcast([...(this.memberships.get(channel.id) ?? [])].filter((peer) => this.allowed(peer.account!, "text", channel)), "message.created", message);
    }
    else {
      const recipients = new Set([...(this.online.get(message.senderId) ?? []), ...(this.online.get(message.recipientId!) ?? [])]);
      this.broadcast(recipients, "message.created", message);
    }
    return { messageId: message.id };
  }

  private async dispatch(peer: Peer, request: Request) {
    if (request.type === "connection.authenticate") {
      if (peer.account || peer.deadline <= Date.now()) fail("AUTH_FAILED");
      if (!request.payload.versions.includes(1)) fail("VERSION_UNSUPPORTED");
      const session = this.auth.consumeTicket(request.payload.ticket);
      const group = this.online.get(session.accountId) ?? new Set<Peer>();
      if (group.size >= this.config.limits.connections_per_account || !group.size && this.online.size >= this.config.server.max_users) fail("LIMIT");
      peer.session = session;
      peer.account = this.auth.account(session.accountId);
      peer.adminMuted = !!this.db.select({ accountId: speakingRestrictions.accountId }).from(speakingRestrictions)
        .where(eq(speakingRestrictions.accountId, session.accountId)).get();
      peer.adminDeafened = !!this.db.select({ accountId: hearingRestrictions.accountId }).from(hearingRestrictions)
        .where(eq(hearingRestrictions.accountId, session.accountId)).get();
      this.pending--;
      group.add(peer);
      this.online.set(session.accountId, group);
      this.connected.set(peer.id, peer);
      this.presenceAccount(session.accountId, peer);
      return this.snapshot(peer);
    }
    const actor = this.verify(peer);
    if (request.type.startsWith("media.")) {
      this.mediaRate.take(actor.id);
      if (request.type === "media.ice.restart") this.iceRate.take(actor.id);
      return this.media.handle(peer, request as Extract<Request, { type: `media.${string}` }>, (send, receive) => {
        const current = this.verify(peer);
        const channel = this.channelMember(peer);
        this.require(current, "join", channel);
        if (send) {
          this.require(current, "speak", channel);
          if (peer.muted || peer.adminMuted || peer.deafened || peer.adminDeafened || peer.afk) fail("FORBIDDEN");
        }
        if (receive && (peer.deafened || peer.adminDeafened || peer.afk)) fail("FORBIDDEN");
      });
    }
    switch (request.type) {
      case "connection.renew": {
        const session = this.auth.consumeTicket(request.payload.ticket);
        if (session.id !== peer.session!.id) fail("AUTH_FAILED");
        peer.session = session;
        return { expiresAt: session.expiresAt };
      }
      case "heartbeat": return { time: Date.now(), sessionExpiresAt: peer.session!.expiresAt };
      case "state.get": return this.snapshot(peer);
      case "channel.create":
      case "channel.edit": return this.changeChannel(peer, request.payload);
      case "channel.delete": {
        const channel = this.channel(request.payload.channelId);
        this.require(actor, "deleteChannels", channel);
        if (channel.id === LOBBY || [...this.catalog.values()].some(({ parentId }) => parentId === channel.id)) fail("CONFLICT");
        this.removeChannel(channel.id, actor.id);
        break;
      }
      case "channel.join": {
        this.joinRate.take(actor.id);
        const { channelId, password } = request.payload;
        const channel = this.channel(channelId);
        this.require(actor, "join", channel);
        if (channel.passwordHash && peer.channelId !== channelId &&
            (!password || !await this.password(() => Bun.password.verify(password, channel.passwordHash!)))) fail("FORBIDDEN");
        const current = this.verify(peer);
        if (this.channel(channelId) !== channel) fail("CONFLICT");
        this.require(current, "join", channel);
        this.join(peer, channel);
        return this.snapshot(peer);
      }
      case "channel.leave": this.leave(peer); return this.snapshot(peer);
      case "channel.move": {
        const target = this.peer(request.payload.connectionId);
        const channel = this.channel(request.payload.channelId);
        this.require(actor, "move", channel);
        if (target.channelId) this.require(actor, "move", this.channelMember(target));
        this.subordinate(actor, target.account!);
        this.require(target.account!, "join", channel);
        this.join(target, channel);
        audit(this.db, actor.id, "channel.moved", target.account!.id);
        this.event(target, "channel.changed", { channelId: channel.id });
        break;
      }
      case "presence.set": {
        const { muted, deafened, afk, afkMessage } = request.payload;
        peer.muted = muted ?? peer.muted;
        peer.deafened = deafened ?? peer.deafened;
        peer.afk = afk ?? peer.afk;
        if (afkMessage !== undefined) peer.afkMessage = afkMessage.trim();
        const member = this.member(peer);
        if (member.muted || member.deafened) this.media.stopSending(peer.id);
        if (member.deafened) this.media.stopReceiving(peer.id);
        this.memberChanged(peer);
        return member;
      }
      case "role.set": {
        this.setRole(actor, request.payload.accountId, request.payload.role);
        break;
      }
      case "channel.override": {
        const { channelId, role, permission, allow } = request.payload;
        this.channel(channelId);
        this.require(actor, "manageRoles");
        this.require(actor, "editChannels");
        this.require(actor, permission);
        if (this.rank(role) >= this.rank(actor.role)) fail("FORBIDDEN");
        this.db.transaction((tx) => {
          if (allow === null) tx.delete(channelOverrides).where(and(eq(channelOverrides.channelId, channelId),
            eq(channelOverrides.role, role), eq(channelOverrides.permission, permission))).run();
          else tx.insert(channelOverrides).values({ channelId, role, permission, allow }).onConflictDoUpdate({
            target: [channelOverrides.channelId, channelOverrides.role, channelOverrides.permission], set: { allow },
          }).run();
          audit(tx, actor.id, "channel.permission_changed", channelId);
        }, { behavior: "immediate" });
        const overrides = this.overrides.get(channelId) ?? new Map();
        if (allow === null) overrides.delete(`${role}/${permission}`);
        else overrides.set(`${role}/${permission}`, allow);
        this.overrides.set(channelId, overrides);
        this.recheckAll();
        break;
      }
      case "moderation.mute":
      case "moderation.deafen": {
        const target = this.peer(request.payload.connectionId);
        const channel = this.channelMember(target);
        this.require(actor, "mute");
        this.require(actor, "mute", channel);
        this.subordinate(actor, target.account!);
        const accountId = target.account!.id;
        const deafen = request.type === "moderation.deafen";
        const table = deafen ? hearingRestrictions : speakingRestrictions;
        const restricted = request.type === "moderation.deafen" ? request.payload.deafened : request.payload.muted;
        const action = deafen ? (restricted ? "account.deafened" : "account.undeafened")
          : (restricted ? "account.muted" : "account.unmuted");
        this.db.transaction((tx) => {
          if (restricted) tx.insert(table).values({ accountId, actorId: actor.id }).onConflictDoNothing().run();
          else tx.delete(table).where(eq(table.accountId, accountId)).run();
          audit(tx, actor.id, action, accountId);
        }, { behavior: "immediate" });
        for (const connection of [...(this.online.get(accountId) ?? [])]) {
          if (deafen) connection.adminDeafened = restricted;
          else connection.adminMuted = restricted;
          if (restricted) {
            this.media.stopSending(connection.id);
            if (deafen) this.media.stopReceiving(connection.id);
          }
          this.memberChanged(connection);
        }
        break;
      }
      case "moderation.kick":
      case "moderation.ban":
      case "moderation.unban": {
        const { accountId } = request.payload;
        this.require(actor, request.type === "moderation.kick" ? "kick" : "ban");
        this.subordinate(actor, this.auth.account(accountId));
        if (request.type === "moderation.ban") {
          const seconds = request.payload.expiresInSeconds;
          this.auth.ban(actor.id, accountId, seconds ? Date.now() + seconds * 1000 : null);
        } else {
          this.db.transaction((tx) => {
            if (request.type === "moderation.unban") tx.delete(bans).where(eq(bans.accountId, accountId)).run();
            audit(tx, actor.id, request.type, accountId);
          }, { behavior: "immediate" });
          if (request.type === "moderation.kick") {
            for (const target of [...(this.online.get(accountId) ?? [])]) this.disconnect(target, 4403, "Kicked");
          }
        }
        break;
      }
      case "invitation.create": {
        this.require(actor, "manageInvitations");
        const { expiresInSeconds, uses, expiresAt } = request.payload;
        return this.auth.invitation(actor, expiresInSeconds, uses, expiresAt);
      }
      case "invitation.list": this.require(actor, "manageInvitations"); return this.auth.invitations(actor);
      case "invitation.revoke": this.require(actor, "manageInvitations"); this.auth.revokeInvitation(actor, request.payload.invitationId); break;
      case "admin.diagnostics": {
        this.require(actor, "viewAdmin");
        const stats = await this.media.diagnostics();
        this.require(this.verify(peer), "viewAdmin");
        return { users: this.online.size, connections: this.connected.size, activeChannels: this.memberships.size,
          memory: process.memoryUsage(), cpu: process.cpuUsage(), ...stats };
      }
      case "admin.audit":
        this.require(actor, "viewAdmin");
        return this.db.select().from(auditEvents).where(request.payload.before ? lt(auditEvents.id, request.payload.before) : undefined)
          .orderBy(desc(auditEvents.id)).limit(100).all();
      case "server.settings": {
        this.require(actor, "manageSettings");
        const { name, registration } = request.payload;
        if (name !== undefined && process.env.VOICE_SERVER_NAME !== undefined ||
            registration !== undefined && process.env.VOICE_SERVER_REGISTRATION !== undefined) fail("FORBIDDEN");
        this.db.transaction((tx) => {
          for (const [key, value] of Object.entries({ name: name?.trim(), registration })) if (value !== undefined) {
            tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
          }
          audit(tx, actor.id, "server.settings_changed", null);
        }, { behavior: "immediate" });
        if (name !== undefined) this.config.server.name = name.trim();
        if (registration !== undefined) this.config.server.registration = registration;
        this.broadcastAll("server.changed", { name: this.config.server.name, registration: this.config.server.registration });
        break;
      }
      case "message.send": return this.sendMessage(peer, request.payload);
      case "message.history": return this.history(peer, request.payload);
      case "message.delete": {
        const message = this.db.select().from(messages).where(eq(messages.id, request.payload.messageId)).get() ?? fail("NOT_FOUND");
        if (message.channelId) {
          const channel = this.channel(message.channelId);
          if (peer.channelId !== channel.id || !this.allowed(actor, "join", channel)) fail("NOT_FOUND");
          if (message.senderId !== actor.id) this.require(actor, "deleteChannels", channel);
        } else if (message.senderId !== actor.id) fail("NOT_FOUND");
        this.db.transaction((tx) => {
          tx.delete(messages).where(eq(messages.id, message.id)).run();
          audit(tx, actor.id, "message.deleted", message.id);
        }, { behavior: "immediate" });
        const event = { messageId: message.id };
        if (message.channelId) this.broadcast(this.memberships.get(message.channelId), "message.deleted", event);
        else {
          const recipients = new Set([...(this.online.get(message.senderId) ?? []), ...(this.online.get(message.recipientId!) ?? [])]);
          this.broadcast(recipients, "message.deleted", event);
        }
        break;
      }
      default: fail("INVALID_REQUEST");
    }
    return {};
  }
}
