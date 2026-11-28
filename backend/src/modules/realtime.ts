import { and, count, desc, eq, gt, gte, isNotNull, like, lt, sql, sum } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../config";
import { audit, channelPermissions, defaultPermissions, DEFAULT_ROLE_KEY, editableBuiltInRoles, INITIAL_ROLE, isBaseRole, LOBBY,
  MAX_ACCOUNT_ROLES, inheritedChannelPermissions, limitAuditInserts, memberPermissions, permissions, pruneAudit, roles, type Permission, type Role, type Store } from "../database";
import { accountRoleNames } from "./auth";
import { accounts, accountRoles, attachments, auditEvents, bans, channelOverrides, channels, hearingRestrictions, messages, rolePermissions, rolesTable, settings, speakingRestrictions } from "../database/schema";
import { attachmentDataLength, bytesPerMiB, decode, defaultAttachmentMiB, maxSupportedAttachmentMiB, pokeMaxLength, type httpBodies, type Request } from "../protocol";
import { errorResponse, fail, ProtocolError, RateLimit } from "../security/errors";
import { sanitizeChatHtml } from "../security/html";
import { PasswordWork } from "../security/work";
import { Auth, banExpiry, isBanned, type Account, type Session } from "./auth";
import { DirectMessages } from "./direct-messages";
import { LiveMessageIndex, liveMessageLifetime } from "./live-message-index";
import { Media, type VideoSource, type WhisperRoute } from "./media";
import { MessageStorage } from "./message-storage";

type Channel = typeof channels.$inferSelect;
type Socket = { sendText(data: string): number; ping(data: Buffer): number; close(code?: number, reason?: string): unknown; terminate(): unknown };
type Peer = { id: string; socket: Socket; source: string; session: Session | null; account: Account | null; channelId: string | null; membershipEpoch: number;
  /** A channel whose chat this connection follows without joining it. */
  viewChannelId: string | null;
  connectedAt: number; latencyMs: number | null; probe?: { token: Buffer; sentAt: number };
  afk: boolean; afkMessage: string;
  muted: boolean; deafened: boolean; adminMuted: boolean; adminDeafened: boolean;
  /**
   * A channel a moderator moved this connection into without its own `join` or `speak` grant.
   * The placement stands in for both grants there, behind a server mute that lasts until a
   * moderator lifts it or the connection leaves.
   */
  placedChannelId: string | null; placementMuted: boolean;
  deadline: number; closed: boolean; pending: number;
  queue: Promise<void>; latest: number; replayBytes: number; replies: Map<number, { digest: string; reply: string; size: number }> };
type AttachmentData = { name: string; size: number; data: Buffer };
type MessageReference = Pick<typeof messages.$inferSelect, "id" | "channelId" | "senderId" | "recipientId">;
type LiveAttachment = { message: MessageReference; file: AttachmentData; expiresAt: number };
type ChannelChange = Extract<Request, { type: "channel.edit" | "channel.create" }>["payload"];
const compareChannels = (a: Channel, b: Channel) =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const replyWindow = 16;
const probeIntervalSeconds = 10;
const replayByteLimit = 262144;
const liveAttachmentLimit = 32 * bytesPerMiB;
const liveAttachmentLimitPerAccount = 8 * bytesPerMiB;
const registrationGrants = new Set<Permission>(memberPermissions);
const configurableRoles = new Set<Role>(editableBuiltInRoles);
const videoPermissions = { screen: "shareScreen", camera: "useCamera" } satisfies Record<VideoSource, Permission>;
const auditActor = alias(accounts, "audit_actor_account");
const auditTarget = alias(accounts, "audit_target_account");
const kickSeconds = 60;

export class Realtime {
  private readonly peers = new Map<string, Peer>();
  private readonly connected = new Map<string, Peer>();
  private readonly online = new Map<string, Set<Peer>>();
  private readonly memberships = new Map<string, Set<Peer>>();
  private readonly viewers = new Map<string, Set<Peer>>();
  private readonly catalog = new Map<string, Channel>();
  private readonly roleGrants = new Map<Role, Set<Permission>>();
  private readonly customRoles = new Map<Role, number>();
  private readonly overrides = new Map<string, Map<string, boolean>>();
  /** Memoised permission results keyed by role set, channel and permission. Cleared whenever grants, overrides or the channel tree change. */
  private readonly permissionCache = new Map<string, boolean>();
  /** Increases whenever any account's roles change, so role managers can refresh their account listings. */
  private accountsRevision = 0;
  private readonly liveText = new LiveMessageIndex<MessageReference>();
  private readonly liveAttachments = new Map<string, LiveAttachment>();
  private readonly liveAttachmentBytesByAccount = new Map<string, number>();
  private liveAttachmentBytes = 0;
  private readonly attachmentDownloadRate: RateLimit;
  private readonly requestRate: RateLimit;
  private readonly messageRate: RateLimit;
  private readonly pokeRate = new RateLimit(6);
  private readonly directMessages: DirectMessages;
  private readonly messageStorage: MessageStorage;
  private readonly mediaRate: RateLimit;
  private readonly iceRate: RateLimit;
  private readonly joinRate: RateLimit;
  private readonly timer: ReturnType<typeof setInterval>;
  private tick = 0;
  private pending = 0;
  private readonly pendingByIp = new Map<string, number>();
  private readonly pendingLimitPerIp: number;
  private readonly passwordWork = new PasswordWork();
  private readonly kicked = new Map<string, number>();
  private motd: string;
  private defaultRole: Role;
  private defaultAudioBitrate: number | null;
  private maxAttachmentMiB: number;
  private banner: string | null;

  constructor(private readonly db: Store, private readonly auth: Auth, private readonly media: Media, private readonly config: Config) {
    this.messageStorage = new MessageStorage(db, config.messaging);
    this.directMessages = new DirectMessages(db, config, this.messageStorage);
    this.banner = db.select().from(settings).where(eq(settings.key, "bannerImageUrl")).get()?.value ?? null;
    this.motd = db.select().from(settings).where(eq(settings.key, "motd")).get()?.value ?? "";
    this.defaultRole = db.select().from(settings).where(eq(settings.key, DEFAULT_ROLE_KEY)).get()?.value ?? INITIAL_ROLE;
    const bitrate = db.select().from(settings).where(eq(settings.key, "defaultAudioBitrate")).get()?.value;
    this.defaultAudioBitrate = bitrate === undefined ? null : Number(bitrate);
    const attachmentLimit = Number(db.select().from(settings).where(eq(settings.key, "maxAttachmentMiB")).get()?.value);
    this.maxAttachmentMiB = Number.isInteger(attachmentLimit) && attachmentLimit >= 1 && attachmentLimit <= maxSupportedAttachmentMiB
      ? attachmentLimit : defaultAttachmentMiB;
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
    this.joinRate = new RateLimit(config.limits.channel_joins_per_minute);
    this.attachmentDownloadRate = new RateLimit(config.limits.attachment_download_bytes_per_minute);
    this.messageRate = new RateLimit(config.messaging.per_minute);
    this.pendingLimitPerIp = Math.min(config.limits.pending_connections_per_ip, Math.max(1, Math.floor(config.limits.pending_connections / 2)));
    limitAuditInserts(db, config.limits.audit_events);
    this.timer = setInterval(() => this.sweep(), 1000);
    auth.onRevoked = (ids) => {
      for (const peer of this.peers.values()) if (peer.session && ids.has(peer.session.id)) this.disconnect(peer, 4401, "Session revoked");
    };
    auth.onAccountChanged = (id) => this.accountChanged(id);
    auth.onAccountCreated = () => this.broadcastAll("state.invalidated", {});
    media.event = (channelId, type, payload) => {
      if (type === "channel.voiceActivity") this.broadcastVisible(channelId, type, payload);
      else this.broadcast(this.memberships.get(channelId), type, payload);
    };
    media.peerEvent = (peerId, type, payload) => {
      const peer = this.connected.get(peerId);
      if (peer) this.event(peer, type, payload);
    };
  }

  open(id: string, socket: Socket, source: string) {
    const pendingFromSource = this.pendingByIp.get(source) ?? 0;
    if (this.pending >= this.config.limits.pending_connections || pendingFromSource >= this.pendingLimitPerIp) {
      socket.close(4429, "Too many pending connections");
      return;
    }
    this.pending++;
    this.pendingByIp.set(source, pendingFromSource + 1);
    this.peers.set(id, { id: randomUUID(), socket, source, session: null, account: null, channelId: null, membershipEpoch: 0, viewChannelId: null,
      connectedAt: 0, latencyMs: null,
      afk: false, afkMessage: "",
      muted: false, deafened: false, adminMuted: false, adminDeafened: false, placedChannelId: null, placementMuted: false, deadline: Date.now() + 5000, closed: false,
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
  receivedPong(id: string, data: Buffer) {
    const peer = this.peers.get(id);
    if (!peer?.probe || peer.closed || !peer.probe.token.equals(data)) return;
    peer.latencyMs = Math.round(performance.now() - peer.probe.sentAt);
    peer.probe = undefined;
  }
  private probeConnection(peer: Peer) {
    if (peer.probe) peer.latencyMs = null;
    const token = randomBytes(8);
    peer.probe = { token, sentAt: performance.now() };
    if (peer.socket.ping(token) === 0) {
      peer.probe = undefined;
      peer.latencyMs = null;
    }
  }
  private releasePending(source: string) {
    this.pending--;
    const remaining = this.pendingByIp.get(source)! - 1;
    if (remaining) this.pendingByIp.set(source, remaining);
    else this.pendingByIp.delete(source);
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
      this.unview(peer);
      audit(this.db, peer.account.id, "connection.closed", null, { connectionId: peer.id });
      if (!group.size) {
        this.broadcastAll("presence.offline", { accountId: peer.account.id });
      } else this.presenceAccount(peer.account.id);
    } else this.releasePending(peer.source);
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
        if (!peer.closed && this.tick % probeIntervalSeconds === 0) this.probeConnection(peer);
      }
    }
    this.tick++;
    const persistent = this.tick === 60;
    this.auth.sweep(now, persistent);
    this.messageStorage.prune(now);
    pruneAudit(this.db, now - this.config.limits.audit_retention_hours * 3600000, this.config.limits.audit_events);
    if (persistent) {
      this.tick = 0;
      this.directMessages.pruneLive(now);
      this.liveText.prune(now);
      for (const [id, entry] of this.liveAttachments) {
        if (entry.expiresAt <= now) this.removeLiveAttachment(id);
      }
      for (const [accountId, until] of this.kicked) if (until <= now) this.kicked.delete(accountId);
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
  private activeDevices(accountId: string) {
    return [...(this.online.get(accountId) ?? [])].filter(({ session }) => session && this.auth.getSession(session.id));
  }
  private broadcastVisible(channelId: string, type: string, payload: unknown) {
    const channel = this.catalog.get(channelId);
    if (!channel) return;
    for (const peers of this.online.values()) {
      if ([...peers].some((peer) => this.canJoin(peer, channel))) this.broadcast(peers, type, payload);
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
    const { id, displayName, avatarId } = members.values().next().value!.account!;
    this.broadcast([...this.online.values()].flatMap((set) => [...set]), "presence.changed",
      { accountId: id, displayName, avatarId, connections: members.size }, except);
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
  private placed(peer: Peer, channel: Channel) {
    return peer.channelId === channel.id && peer.placedChannelId === channel.id;
  }
  private canJoin(peer: Peer, channel: Channel) {
    return this.placed(peer, channel) || this.allowed(peer.account!, "join", channel);
  }
  private canSpeak(peer: Peer, channel: Channel) {
    return this.placed(peer, channel) || this.allowed(peer.account!, "speak", channel);
  }
  private allowed(account: { roles: readonly Role[] }, permission: Permission, channel?: Channel) {
    return this.rolesAllowed(account.roles, permission, channel);
  }
  private roleAllowed(role: Role, permission: Permission, channel?: Channel) {
    return this.rolesAllowed([role], permission, channel);
  }
  /**
   * Combines every held role. Owner always passes. Otherwise the nearest channel level with an override for any
   * held role decides, and an allow there beats a deny. Without one, any held role's server-wide grant allows.
   */
  private rolesAllowed(held: readonly Role[], permission: Permission, channel?: Channel) {
    if (held.includes("Owner")) return true;
    // Hypothetical channels (such as a channel previewed under a new parent) bypass the cache.
    const cacheable = !channel || this.catalog.get(channel.id) === channel;
    const key = `${held.join("\0")}\0${channel?.id ?? ""}\0${permission}`;
    const cached = cacheable ? this.permissionCache.get(key) : undefined;
    if (cached !== undefined) return cached;
    const result = this.channelOverride(held, permission, channel) ?? held.some((role) => this.roleGrants.get(role)?.has(permission));
    if (cacheable) {
      if (this.permissionCache.size >= 100_000) this.permissionCache.clear();
      this.permissionCache.set(key, result);
    }
    return result;
  }
  private channelOverride(held: readonly Role[], permission: Permission, channel?: Channel) {
    for (let current = channel; current; current = current.parentId ? this.catalog.get(current.parentId) : undefined) {
      const overrides = this.overrides.get(current.id);
      if (!overrides) continue;
      let denied = false;
      for (const role of held) {
        const override = overrides.get(`${role}/${permission}`);
        if (override) return true;
        if (override === false) denied = true;
      }
      if (denied) return false;
    }
    return undefined;
  }
  private clearPermissionCache() { this.permissionCache.clear(); }
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
  /** An account's place in the hierarchy is that of its highest-ranked role. */
  private effectiveRank(account: { roles: readonly Role[] }) {
    return Math.max(...account.roles.map((role) => this.rank(role)));
  }
  private holdsServerGrants(actor: Account, grants?: ReadonlySet<Permission>) {
    return [...grants ?? []].every((permission) => this.allowed(actor, permission));
  }
  private holdsRoleGrants(actor: Account, role: Role, grants = this.roleGrants.get(role)) {
    if (actor.roles.includes("Owner")) return true;
    if (!this.holdsServerGrants(actor, grants)) return false;
    // Effective grants can only differ from their parent where the role or one the actor holds has an override.
    for (const [channelId, overrides] of this.overrides) {
      for (const permission of inheritedChannelPermissions) {
        if (!overrides.has(`${role}/${permission}`) && !actor.roles.some((held) => overrides.has(`${held}/${permission}`))) continue;
        const channel = this.channel(channelId);
        const granted = this.channelOverride([role], permission, channel) ?? grants?.has(permission);
        if (granted && !this.allowed(actor, permission, channel)) return false;
      }
    }
    return true;
  }
  private canManageRole(actor: Account, role: Role) {
    return this.rank(role) < this.effectiveRank(actor) && this.holdsRoleGrants(actor, role);
  }
  private lowerRoles(actor: Account) {
    const rank = this.effectiveRank(actor);
    return [...roles, ...this.customRoles.keys()].filter((role) => this.rank(role) < rank);
  }
  listAccounts(accountId: string, after?: string) {
    const actor = this.authorize(accountId, "manageRoles");
    const rows = this.db.select({ id: accounts.id, displayName: accounts.displayName, badge: accounts.badge })
      .from(accounts).where(after ? gt(accounts.id, after) : undefined).orderBy(accounts.id).limit(51).all();
    const page = rows.slice(0, 50);
    const held = accountRoleNames(this.db, page.map(({ id }) => id));
    const manageable = new Set(this.lowerRoles(actor).filter((role) => this.holdsRoleGrants(actor, role)));
    const actorCanBan = this.allowed(actor, "ban");
    const actorRank = this.effectiveRank(actor);
    const accountsPage = page.map((row) => {
      const roles = held.get(row.id)!;
      const account = { ...row, role: roles[0]!, roles };
      const bannedUntil = banExpiry(this.db, account.id);
      return {
        ...account,
        editable: this.effectiveRank(account) < actorRank,
        bannable: actorCanBan && this.canBan(actor, account),
        banned: bannedUntil !== undefined,
        bannedUntil: bannedUntil ?? null,
      };
    });
    const canDefineRoles = actorRank >= this.rank("Administrator");
    const customRoles = [...this.customRoles.keys()];
    return { accounts: accountsPage, next: rows.length > 50 ? accountsPage.at(-1)!.id : null,
      roles: [...manageable],
      builtInRoles: canDefineRoles ? roles.map((name) => ({ name, permissions: [...this.roleGrants.get(name) ?? []],
        editable: configurableRoles.has(name) && manageable.has(name), defaultPermissions: [...defaultPermissions[name]] })) : [],
      customRoles: canDefineRoles ? customRoles.map((name) => ({ name, permissions: [...this.roleGrants.get(name) ?? []] })) : [],
      assignablePermissions: canDefineRoles ? permissions.filter((permission) => this.allowed(actor, permission)) : [],
      canDefineRoles, defaultRole: this.defaultRole, registrationPermissions: [...registrationGrants] };
  }
  /**
   * Combining roles can unlock a permission that no single role grants on its own, for example when removing a role
   * lifts its channel deny. Wherever the change unlocks a permission, the actor must hold it there too.
   */
  private authorizeRoleSetChange(actor: Account, before: readonly Role[], after: readonly Role[]) {
    for (const permission of permissions) {
      if (!this.rolesAllowed(before, permission) && this.rolesAllowed(after, permission)) this.require(actor, permission);
    }
    for (const channel of this.catalog.values()) {
      for (const permission of inheritedChannelPermissions) {
        if (!this.rolesAllowed(before, permission, channel) && this.rolesAllowed(after, permission, channel)) {
          this.require(actor, permission, channel);
        }
      }
    }
  }
  addRole(actor: Account, accountId: string, role: Role) { return this.changeRole(actor, accountId, role, true); }
  removeRole(actor: Account, accountId: string, role: Role) { return this.changeRole(actor, accountId, role, false); }
  /** Requires outranking every role the account holds and controlling the changed role's grants. */
  private changeRole(actor: Account, accountId: string, role: Role, add: boolean) {
    this.require(actor, "manageRoles");
    const target = this.auth.account(accountId);
    if (this.effectiveRank(target) >= this.effectiveRank(actor) || !this.canManageRole(actor, role)) fail("FORBIDDEN");
    if (target.roles.includes(role) === add) return { roles: target.roles };
    if (add && target.roles.length >= MAX_ACCOUNT_ROLES) {
      throw new ProtocolError("CONFLICT", `An account can hold at most ${MAX_ACCOUNT_ROLES} roles.`);
    }
    if (!add && isBaseRole(role) && !target.roles.some((held) => held !== role && isBaseRole(held))) {
      throw new ProtocolError("CONFLICT", "An account must keep the Guest or Member role.");
    }
    this.authorizeRoleSetChange(actor, target.roles, add ? [...target.roles, role] : target.roles.filter((held) => held !== role));
    const roles = this.db.transaction((tx) => {
      if (add) tx.insert(accountRoles).values({ accountId, role }).run();
      else tx.delete(accountRoles).where(and(eq(accountRoles.accountId, accountId), eq(accountRoles.role, role))).run();
      const roles = accountRoleNames(tx, [accountId]).get(accountId)!;
      audit(tx, actor.id, add ? "role.added" : "role.removed", accountId, { role, roles });
      return roles;
    }, { behavior: "immediate" });
    this.accountChanged(accountId);
    this.accountsRevision++;
    const managers = [...this.online.values()].flatMap((peers) => [...peers])
      .filter((peer) => peer.account!.id !== accountId && this.allowed(peer.account!, "manageRoles"));
    this.broadcast(managers, "state.invalidated", {});
    return { roles };
  }
  setBadge(actorId: string, accountId: string, label: string | null) {
    const actor = this.authorize(actorId, "manageRoles");
    const target = this.auth.account(accountId);
    this.subordinate(actor, target);
    const badge = label?.trim() ?? null;
    if (target.badge !== badge) {
      this.db.transaction((tx) => {
        tx.update(accounts).set({ badge }).where(eq(accounts.id, accountId)).run();
        audit(tx, actor.id, "account.badge_changed", accountId, { previousBadge: target.badge, badge });
      }, { behavior: "immediate" });
      this.accountChanged(accountId);
    }
    return { badge };
  }
  defineRole(accountId: string, name: Role, grants: Permission[], create: boolean) {
    const actor = this.authorize(accountId, "manageRoles");
    if (this.effectiveRank(actor) < this.rank("Administrator")) fail("FORBIDDEN");
    if (create) {
      if ([...roles, ...this.customRoles.keys()].some((role) => role.toLowerCase() === name.toLowerCase())) {
        throw new ProtocolError("CONFLICT", "A role with that name already exists.");
      }
    } else if (!this.customRoles.has(name) && !configurableRoles.has(name)) {
      if (roles.some((role) => role === name)) fail("FORBIDDEN");
      fail("NOT_FOUND");
    }
    if (!create && !this.canManageRole(actor, name)) fail("FORBIDDEN");
    const unique = new Set(grants);
    if (!this.holdsRoleGrants(actor, name, unique)) fail("FORBIDDEN");
    if (name === this.defaultRole && [...unique].some((permission) => !registrationGrants.has(permission))) {
      throw new ProtocolError("CONFLICT", "Choose a different default role before granting elevated permissions to this role.");
    }
    const previousPermissions = [...this.roleGrants.get(name) ?? []];
    if (!create && previousPermissions.length === unique.size && previousPermissions.every((permission) => unique.has(permission))) {
      return { name, permissions: previousPermissions };
    }
    // Negative database ranks distinguish custom roles from the fixed built-in ranks.
    const rank = create ? Math.min(0, ...this.customRoles.values()) - 1 : undefined;
    this.db.transaction((tx) => {
      if (rank !== undefined) tx.insert(rolesTable).values({ name, rank }).run();
      else tx.delete(rolePermissions).where(eq(rolePermissions.role, name)).run();
      if (unique.size) tx.insert(rolePermissions).values([...unique].map((permission) => ({ role: name, permission }))).run();
      audit(tx, actor.id, create ? "role.created" : "role.permissions_changed", name, {
        previousPermissions, permissions: [...unique],
      });
    }, { behavior: "immediate" });
    if (rank !== undefined) this.customRoles.set(name, rank);
    this.roleGrants.set(name, unique);
    this.clearPermissionCache();
    this.recheckAll();
    return { name, permissions: [...unique] };
  }
  deleteRole(accountId: string, name: Role) {
    const actor = this.authorize(accountId, "manageRoles");
    if (this.effectiveRank(actor) < this.rank("Administrator")) fail("FORBIDDEN");
    if (!this.customRoles.has(name)) fail("NOT_FOUND");
    if (!this.canManageRole(actor, name)) fail("FORBIDDEN");
    if (this.defaultRole === name) throw new ProtocolError("CONFLICT", "Choose a different default role before deleting this role.");
    this.db.transaction((tx) => {
      if (tx.select().from(accountRoles).where(eq(accountRoles.role, name)).limit(1).get()) {
        throw new ProtocolError("CONFLICT", "Reassign accounts using this role before deleting it.");
      }
      tx.delete(channelOverrides).where(eq(channelOverrides.role, name)).run();
      tx.delete(rolePermissions).where(eq(rolePermissions.role, name)).run();
      tx.delete(rolesTable).where(eq(rolesTable.name, name)).run();
      audit(tx, actor.id, "role.deleted", name);
    }, { behavior: "immediate" });
    this.customRoles.delete(name);
    this.roleGrants.delete(name);
    for (const overrides of this.overrides.values()) {
      for (const key of overrides.keys()) if (key.startsWith(`${name}/`)) overrides.delete(key);
    }
    this.clearPermissionCache();
    this.broadcastAll("state.invalidated", {});
    return {};
  }
  private registrationRoles() {
    return ["Guest", INITIAL_ROLE, ...this.customRoles.keys()].filter((role) =>
      [...this.roleGrants.get(role) ?? []].every((permission) => registrationGrants.has(permission)) &&
      [...this.overrides.values()].every((overrides) =>
        channelPermissions.every((permission) => registrationGrants.has(permission) || overrides.get(`${role}/${permission}`) !== true)));
  }
  get bannerImageUrl() { return this.visibleImage(this.banner); }
  private imageHostAllowed(host: string) {
    const hosts = this.config.server.image_hosts;
    return !hosts.length || hosts.includes(host.toLowerCase());
  }
  private imageUrl(value: string) {
    const url = URL.parse(value);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.href.length > 512) fail("INVALID_REQUEST");
    if (!this.imageHostAllowed(url.hostname)) {
      throw new ProtocolError("FORBIDDEN", "Images must come from a host this server allows.");
    }
    return url.href;
  }
  // Stored URLs are rechecked so tightening server.image_hosts takes effect immediately.
  private visibleImage(value: string | null) {
    const url = value ? URL.parse(value) : null;
    return url && this.imageHostAllowed(url.hostname) ? value : null;
  }
  get targetAudioBitrate() {
    return process.env.VOICE_MEDIA_TARGET_AUDIO_BITRATE !== undefined ? this.config.media.target_audio_bitrate :
      this.defaultAudioBitrate ?? this.config.media.target_audio_bitrate;
  }
  get maxAttachmentBytes() {
    return this.maxAttachmentMiB * bytesPerMiB;
  }
  serverPreferences(accountId: string) {
    const actor = this.authorize(accountId, "manageSettings");
    const canSetDefaultRole = this.allowed(actor, "manageRoles");
    return { motd: this.motd, defaultRole: this.defaultRole, canSetDefaultRole,
      defaultRoles: canSetDefaultRole ? this.registrationRoles().filter((role) => this.canManageRole(actor, role)) : [],
      defaultAudioBitrate: this.defaultAudioBitrate, configuredAudioBitrate: this.config.media.target_audio_bitrate,
      audioBitrateLocked: process.env.VOICE_MEDIA_TARGET_AUDIO_BITRATE !== undefined,
      maxAttachmentMiB: this.maxAttachmentMiB, maxSupportedAttachmentMiB };
  }
  saveServerPreferences(accountId: string, changes: typeof httpBodies.serverPreferences.static) {
    const actor = this.authorize(accountId, "manageSettings");
    const motd = changes.motd?.trim() ?? this.motd;
    const defaultRole = changes.defaultRole?.trim() ?? this.defaultRole;
    const bitrate = changes.defaultAudioBitrate === undefined ? this.defaultAudioBitrate : changes.defaultAudioBitrate;
    const attachmentMiB = changes.maxAttachmentMiB ?? this.maxAttachmentMiB;
    if (defaultRole !== this.defaultRole) {
      this.require(actor, "manageRoles");
      if (!this.registrationRoles().includes(defaultRole) || !this.canManageRole(actor, defaultRole)) fail("FORBIDDEN");
    }
    if (bitrate !== this.defaultAudioBitrate && process.env.VOICE_MEDIA_TARGET_AUDIO_BITRATE !== undefined) fail("FORBIDDEN");
    this.db.transaction((tx) => {
      if (motd !== this.motd) {
        tx.insert(settings).values({ key: "motd", value: motd }).onConflictDoUpdate({ target: settings.key, set: { value: motd } }).run();
        audit(tx, actor.id, "server.motd_changed", null, { enabled: Boolean(motd) });
      }
      if (defaultRole !== this.defaultRole) {
        tx.insert(settings).values({ key: DEFAULT_ROLE_KEY, value: defaultRole })
          .onConflictDoUpdate({ target: settings.key, set: { value: defaultRole } }).run();
        audit(tx, actor.id, "server.default_role_changed", null, { previousRole: this.defaultRole, role: defaultRole });
      }
      if (bitrate !== this.defaultAudioBitrate) {
        const key = "defaultAudioBitrate";
        if (bitrate === null) tx.delete(settings).where(eq(settings.key, key)).run();
        else tx.insert(settings).values({ key, value: String(bitrate) })
          .onConflictDoUpdate({ target: settings.key, set: { value: String(bitrate) } }).run();
        audit(tx, actor.id, "server.voice_quality_changed", null, { previousBitrate: this.defaultAudioBitrate, bitrate });
      }
      if (attachmentMiB !== this.maxAttachmentMiB) {
        const key = "maxAttachmentMiB";
        tx.insert(settings).values({ key, value: String(attachmentMiB) })
          .onConflictDoUpdate({ target: settings.key, set: { value: String(attachmentMiB) } }).run();
        audit(tx, actor.id, "server.attachment_limit_changed", null, {
          previousMaxAttachmentMiB: this.maxAttachmentMiB, maxAttachmentMiB: attachmentMiB,
        });
      }
    }, { behavior: "immediate" });
    const updateSnapshot = motd !== this.motd || bitrate !== this.defaultAudioBitrate || attachmentMiB !== this.maxAttachmentMiB;
    this.motd = motd;
    this.defaultRole = defaultRole;
    this.defaultAudioBitrate = bitrate;
    this.maxAttachmentMiB = attachmentMiB;
    if (updateSnapshot) this.broadcastAll("state.invalidated", {});
    return this.serverPreferences(accountId);
  }
  listAudit(accountId: string, filters: { before?: number | string; actorId?: string; prefix?: string }) {
    this.authorize(accountId, "viewAdmin");
    const { before, actorId, prefix } = filters;
    const rows = this.db.select({ event: auditEvents, actorName: auditActor.displayName,
      targetAccountName: auditTarget.displayName, targetChannelName: channels.name })
      .from(auditEvents)
      .leftJoin(auditActor, eq(auditEvents.actorId, auditActor.id))
      .leftJoin(auditTarget, eq(auditEvents.targetId, auditTarget.id))
      .leftJoin(channels, eq(auditEvents.targetId, channels.id))
      .where(and(before === undefined ? undefined : lt(auditEvents.id, Number(before)),
        actorId ? eq(auditEvents.actorId, actorId) : undefined,
        prefix ? like(auditEvents.action, prefix + ".%") : undefined))
      .orderBy(desc(auditEvents.id)).limit(101).all();
    const events = rows.slice(0, 100).map(({ event, actorName, targetAccountName, targetChannelName }) =>
      ({ ...event, actorName, targetName: targetAccountName ?? targetChannelName }));
    return { events, next: rows.length > 100 ? events.at(-1)!.id : null };
  }
  setBanner(accountId: string, url: string | null) {
    const actor = this.authorize(accountId, "manageSettings");
    const bannerImageUrl = url === null ? null : this.imageUrl(url);
    this.db.transaction((tx) => {
      const key = "bannerImageUrl";
      if (bannerImageUrl === null) tx.delete(settings).where(eq(settings.key, key)).run();
      else tx.insert(settings).values({ key, value: bannerImageUrl })
        .onConflictDoUpdate({ target: settings.key, set: { value: bannerImageUrl } }).run();
      audit(tx, actor.id, "server.banner_changed", null);
    }, { behavior: "immediate" });
    this.banner = bannerImageUrl;
    this.broadcastAll("state.invalidated", {});
    return { bannerImageUrl };
  }
  private subordinate(actor: Account, target: Account) {
    if (target.id === actor.id || this.effectiveRank(actor) <= this.effectiveRank(target)) fail("FORBIDDEN");
  }
  /** Banning is reserved for accounts that cannot themselves ban other users. */
  private canBan(actor: Account, target: { id: string; roles: readonly Role[] }) {
    return target.id !== actor.id && this.effectiveRank(target) < this.effectiveRank(actor) && !this.allowed(target, "ban");
  }
  private channel(id: string) { return this.catalog.get(id) ?? fail("NOT_FOUND"); }
  private channelMember(peer: Peer) { return peer.channelId ? this.channel(peer.channelId) : fail("FORBIDDEN"); }
  private peer(id: string) {
    return this.connected.get(id) ?? fail("NOT_FOUND");
  }
  private member(peer: Peer) {
    const { id, displayName, role, roles, badge } = peer.account!;
    return { connectionId: peer.id, accountId: id, displayName, role, roles, badge,
      afk: peer.afk, afkMessage: peer.afk ? peer.afkMessage : "",
      muted: peer.muted || peer.afk, deafened: peer.deafened || peer.afk, adminMuted: peer.adminMuted || peer.placementMuted,
      adminDeafened: peer.adminDeafened };
  }
  connectionInfo(session: Session, connectionId: string) {
    const peer = this.peer(connectionId);
    const channel = peer.channelId ? this.catalog.get(peer.channelId) : undefined;
    const canSeeChannel = channel && this.allowed(this.auth.account(session.accountId), "join", channel);
    if (peer.session?.id !== session.id && !canSeeChannel) fail("NOT_FOUND");
    return { displayName: peer.account!.displayName, channelName: canSeeChannel ? channel.name : null,
      connectedSeconds: Math.floor((performance.now() - peer.connectedAt) / 1000), latencyMs: peer.latencyMs };
  }
  private snapshot(peer: Peer) {
    const account = peer.account!;
    const joinedChannel = peer.channelId ? this.channel(peer.channelId) : undefined;
    const canSpeak = !!joinedChannel && this.canSpeak(peer, joinedChannel);
    const canSendText = !!joinedChannel && this.allowed(account, "text", joinedChannel);
    const canWhisper = canSpeak && this.allowed(account, "whisper", joinedChannel);
    const visible = [...this.catalog.values()].filter((channel) => this.canJoin(peer, channel));
    const visibleIds = new Set(visible.map(({ id }) => id));
    const parentIds = new Set([...this.catalog.values()].map(({ parentId }) => parentId));
    const lowerRoles = this.lowerRoles(account);
    const { totalUsers } = this.db.select({ totalUsers: count() }).from(accounts).get()!;
    return { connectionId: peer.id, account, channelId: peer.channelId, totalUsers,
      whispers: peer.channelId ? this.media.whispers(peer.channelId) : [],
      screens: peer.channelId ? this.media.screens(peer.channelId) : [],
      cameras: peer.channelId ? this.media.cameras(peer.channelId) : [],
      canSendText,
      canAttachFiles: canSendText && this.allowed(account, "attachFiles", joinedChannel),
      directMessages: { maxBytes: this.directMessages.maxBytes, persistent: this.config.messaging.persistence,
        offlineDelivery: true, canSend: this.allowed(account, "sendDirectMessages") },
      pokeMaxLength,
      canShareScreen: canSpeak && this.allowed(account, "shareScreen", joinedChannel),
      canUseCamera: canSpeak && this.allowed(account, "useCamera", joinedChannel),
      channels: visible.sort(compareChannels).map(
        (channel) => {
          const { id, name, parentId, description, position, capacity, temporary, passwordHash, backgroundImageUrl, icon } = channel;
          const canEdit = this.allowed(account, "editChannels", channel);
          return { id, name, parentId: parentId && visibleIds.has(parentId) ? parentId : null, description, position, capacity,
            temporary, passwordRequired: !!passwordHash, backgroundImageUrl: this.visibleImage(backgroundImageUrl), icon, audioBitrate: channel.audioBitrate,
            canWhisperTo: id !== peer.channelId && canWhisper && this.allowed(account, "speak", channel) &&
              this.allowed(account, "whisper", channel),
            canSetAudioBitrate: this.allowed(account, "manageSettings") && canEdit,
            canDeleteMessages: this.allowed(account, "deleteChannels", channel),
            ...this.chatPermissions(peer, channel),
            canEdit, canReparent: canEdit && id !== LOBBY,
            canDelete: id !== LOBBY && !parentIds.has(id) && this.allowed(account, "removeChannels", channel),
            canSetPassword: id !== LOBBY && canEdit,
            canMute: this.allowed(account, "mute") && this.allowed(account, "mute", channel),
            canMove: this.allowed(account, "move", channel),
            canManagePermissions: this.canManageChannelPermissions(account, channel) };
        }),
      presence: [...this.online.values()].map((connections) => {
        const { id, displayName, avatarId } = connections.values().next().value!.account!;
        return { accountId: id, displayName, avatarId, connections: connections.size };
      }),
      members: peer.channelId ? [...(this.memberships.get(peer.channelId) ?? [])].map((member) => this.member(member)) : [],
      channelMembers: Object.fromEntries(visible.filter(({ id }) => this.memberships.has(id)).map(({ id }) =>
        [id, [...this.memberships.get(id)!].map((member) => this.treeMember(member, id))])),
      serverPermissions: permissions.filter((permission) => this.allowed(account, permission)),
      lowerRoles,
      assignableRoles: this.allowed(account, "manageRoles") ? lowerRoles.filter((role) => this.holdsRoleGrants(account, role)) : [],
      ...this.allowed(account, "manageRoles") ? { accountsRevision: this.accountsRevision } : {},
      bannerImageUrl: this.bannerImageUrl,
      motd: this.motd,
      targetAudioBitrate: this.targetAudioBitrate,
      maxAttachmentBytes: this.maxAttachmentBytes,
      canReorderChannels: visible.some((channel) => this.allowed(account, "editChannels", channel)),
    };
  }
  private leave(peer: Peer) {
    const channelId = peer.channelId;
    if (!channelId) return;
    peer.channelId = null;
    peer.placedChannelId = null;
    peer.placementMuted = false;
    peer.membershipEpoch++;
    audit(this.db, peer.account!.id, "voice.left", channelId, { channelName: this.catalog.get(channelId)?.name ?? null });
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
    if (peer.viewChannelId === channelId && this.catalog.get(channelId)?.passwordHash) this.unview(peer, true);
  }
  private requireChannelCapacity(channel: Channel, incoming: number) {
    if (incoming && (this.memberships.get(channel.id)?.size ?? 0) + incoming >
      Math.min(channel.capacity ?? Infinity, this.config.limits.users_per_channel)) fail("LIMIT");
  }
  private join(peer: Peer, channel: Channel) {
    if (peer.channelId === channel.id) return;
    this.requireChannelCapacity(channel, 1);
    const members = this.memberships.get(channel.id) ?? new Set<Peer>();
    this.leave(peer);
    if (peer.closed || !this.catalog.has(channel.id)) fail("CONFLICT");
    peer.channelId = channel.id;
    peer.membershipEpoch++;
    members.add(peer);
    this.memberships.set(channel.id, members);
    audit(this.db, peer.account!.id, "voice.joined", channel.id, { channelName: channel.name });
    this.broadcastVisible(channel.id, "channel.member", { channelId: channel.id, ...this.treeMember(peer, channel.id) });
    this.broadcast(members, "channel.userJoined", { channelId: channel.id, ...this.member(peer) }, peer);
  }
  private recheck(peer: Peer) {
    const viewed = peer.viewChannelId ? this.catalog.get(peer.viewChannelId) : undefined;
    if (peer.viewChannelId && (!viewed || !this.canChat(peer, viewed))) this.unview(peer, true);
    if (!peer.channelId || peer.closed) return;
    const channel = this.channel(peer.channelId);
    if (!this.canJoin(peer, channel)) {
      this.leave(peer);
      this.event(peer, "channel.changed", { channelId: null });
      return;
    }
    const account = peer.account!;
    const canSpeak = this.canSpeak(peer, channel);
    if (!canSpeak) this.media.stopSending(peer.id);
    this.media.recheckVideo(peer.id, (source) => canSpeak && this.allowed(account, videoPermissions[source], channel));
    if (canSpeak) this.media.recheckWhispers(peer.id, (whisper) => this.canWhisper(peer, whisper));
  }
  private canWhisper(peer: Peer, { channelId, passwordHash }: WhisperRoute) {
    const channel = this.catalog.get(channelId);
    const account = peer.account!;
    return !!peer.channelId && !!channel && channel.id !== peer.channelId && channel.passwordHash === passwordHash &&
      Boolean(this.memberships.get(channelId)?.size) && this.allowed(account, "join", channel) &&
      this.allowed(account, "speak", channel) && this.allowed(account, "whisper", channel) &&
      this.allowed(account, "whisper", this.channel(peer.channelId));
  }
  private recheckAll() {
    for (const group of this.online.values()) for (const peer of [...group]) this.recheck(peer);
    this.broadcastAll("state.invalidated", {});
  }
  private removeChannel(id: string, actor?: string) {
    const name = this.channel(id).name;
    this.db.transaction((tx) => {
      tx.delete(channels).where(eq(channels.id, id)).run();
      audit(tx, actor ?? null, "channel.deleted", id, { channelName: name });
    }, { behavior: "immediate" });
    this.catalog.delete(id);
    this.overrides.delete(id);
    this.clearPermissionCache();
    for (const peer of [...(this.memberships.get(id) ?? [])]) {
      this.leave(peer);
      this.event(peer, "channel.changed", { channelId: null });
    }
    for (const peer of [...(this.viewers.get(id) ?? [])]) this.unview(peer, true);
    this.media.releaseRoom(id);
    this.liveText.removeMatching((message) => message.channelId === id);
    for (const [messageId, entry] of this.liveAttachments) {
      if (entry.message.channelId === id) this.removeLiveAttachment(messageId);
    }
    this.broadcastAll("state.invalidated", {});
  }

  private password<T>(accountId: string, run: () => Promise<T>) { return this.passwordWork.run(accountId, run); }
  reorderChannel(accountId: string, { channelId, targetId, placement, parentId: expectedParentId }: typeof httpBodies.channelOrder.static) {
    // Ordering requires edit access and visibility in both channels.
    const actor = this.auth.account(accountId);
    const source = this.channel(channelId);
    const target = this.channel(targetId);
    this.require(actor, "join", source);
    this.require(actor, "join", target);
    this.require(actor, "editChannels", source);
    this.require(actor, "editChannels", target);
    const parentId = placement === "inside" ? target.id : target.parentId;
    if (expectedParentId !== undefined && expectedParentId !== parentId) fail("CONFLICT");
    if (placement !== "inside" && expectedParentId === undefined && source.parentId !== parentId) fail("CONFLICT");
    if (placement === "inside" && source === target) fail("CONFLICT");
    if (source === target) return {};
    const reparenting = source.parentId !== parentId;
    if (reparenting) this.authorizeReparent(actor, source, parentId ? this.channel(parentId) : undefined);
    const siblings = [...this.catalog.values()].filter((channel) => channel.parentId === parentId && channel !== source)
      .sort(compareChannels);
    const index = placement === "inside" ? siblings.length : siblings.indexOf(target) + (placement === "after" ? 1 : 0);
    siblings.splice(index, 0, source);
    const changes = siblings.flatMap((channel, position) =>
      channel.position === position && channel.parentId === parentId ? [] : [{ ...channel, position, parentId }]);
    if (!changes.length) return {};
    this.db.transaction((tx) => {
      for (const { id, position, parentId } of changes) tx.update(channels).set({ position, parentId }).where(eq(channels.id, id)).run();
      audit(tx, actor.id, "channel.reordered", source.id, { channelName: source.name, placement, relativeTo: target.name });
    }, { behavior: "immediate" });
    for (const channel of changes) this.catalog.set(channel.id, channel);
    this.clearPermissionCache();
    if (reparenting) this.recheckAll();
    else this.broadcastAll("state.invalidated", {});
    return {};
  }
  private authorizeReparent(actor: Account, current: Channel, parent: Channel | undefined) {
    const previousParent = current.parentId ? this.channel(current.parentId) : undefined;
    this.require(actor, "join", current);
    // Check visibility and edit access in each existing parent.
    for (const scope of [previousParent, parent]) {
      if (!scope) continue;
      this.require(actor, "join", scope);
      this.require(actor, "editChannels", scope);
    }
    this.validateChannelParent(current.id, parent, current);

    // A descendant either inherits the moved channel's effective grant or has a closer override.
    const moved = { ...current, parentId: parent?.id ?? null };
    for (const role of [...roles, ...this.customRoles.keys()]) {
      for (const permission of inheritedChannelPermissions) {
        // A deny that appears or disappears matters even when this role's own result stays the same, because it
        // decides the outcome for accounts that combine the role with others.
        const before = this.channelOverride([role], permission, current);
        const after = this.channelOverride([role], permission, moved);
        const denyChanged = before !== after && (before === false || after === false);
        if (!denyChanged && this.roleAllowed(role, permission, current) === this.roleAllowed(role, permission, moved)) continue;
        this.authorizeRolePermissionChange(actor, current, role, permission, true);
      }
    }
  }
  private validateChannelParent(id: string, parent: Channel | undefined, current?: Channel) {
    if (id === LOBBY && parent) fail("FORBIDDEN");
    if (parent?.temporary) fail("CONFLICT");
    let depth = 0;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parentId ? this.channel(ancestor.parentId) : undefined) {
      if (ancestor.id === id || ++depth >= 16) fail("CONFLICT");
    }
    if (!current || current.parentId === (parent?.id ?? null)) return;
    for (const candidate of this.catalog.values()) {
      let child = candidate;
      let descendantDepth = 0;
      while (child.parentId && child.id !== id) {
        child = this.channel(child.parentId);
        descendantDepth++;
      }
      if (child.id === id && depth + descendantDepth >= 16) fail("CONFLICT");
    }
  }
  private canManageChannelPermissions(actor: Account, channel: Channel) {
    return this.allowed(actor, "manageRoles") && this.allowed(actor, "editChannels") &&
      this.allowed(actor, "join", channel) && this.allowed(actor, "editChannels", channel);
  }
  /** Lists each manageable role's override and inherited grant for every channel permission. */
  channelPermissionTable(accountId: string, channelId: string) {
    const actor = this.auth.account(accountId);
    const channel = this.channel(channelId);
    if (!this.canManageChannelPermissions(actor, channel)) fail("FORBIDDEN");
    const parent = channel.parentId ? this.channel(channel.parentId) : undefined;
    const overrides = this.overrides.get(channel.id);
    const roleNames = this.lowerRoles(actor).filter((role) => this.holdsServerGrants(actor, this.roleGrants.get(role)));
    return {
      editable: channelPermissions.filter((permission) => this.allowed(actor, permission) && this.allowed(actor, permission, channel)),
      roles: roleNames.map((name) => ({ name, permissions: Object.fromEntries(channelPermissions.map((permission) => [permission, {
        allow: overrides?.get(`${name}/${permission}`) ?? null, inherited: this.roleAllowed(name, permission, parent),
      }])) })),
    };
  }
  /** Applies override changes in order; each is authorised against the state the previous ones left. */
  setChannelPermissions(accountId: string, channelId: string, { changes }: typeof httpBodies.channelPermissions.static) {
    const actor = this.auth.account(accountId);
    const channel = this.channel(channelId);
    if (!this.canManageChannelPermissions(actor, channel)) fail("FORBIDDEN");
    try {
      for (const change of changes) this.overrideChannel(actor, channel, change);
    } finally { this.recheckAll(); }
    return this.channelPermissionTable(accountId, channelId);
  }
  private overrideChannel(actor: Account, channel: Channel, { role, permission, allow }: { role: Role; permission: Permission; allow: boolean | null }) {
    this.require(actor, "editChannels");
    // Any change to the override reaches the descendants that inherit it, even when this role's own result stays the
    // same, because combined with other held roles an override can still decide the outcome.
    const changed = (this.overrides.get(channel.id)?.get(`${role}/${permission}`) ?? null) !== allow;
    this.authorizeRolePermissionChange(actor, channel, role, permission, changed);
    if (role === this.defaultRole && allow && !registrationGrants.has(permission)) {
      throw new ProtocolError("CONFLICT", "Choose a different default role before granting elevated permissions to this role.");
    }
    const key = `${role}/${permission}`;
    const overrides = this.overrides.get(channel.id) ?? new Map<string, boolean>();
    if ((overrides.get(key) ?? null) === allow) return;
    this.db.transaction((tx) => {
      if (allow === null) tx.delete(channelOverrides).where(and(eq(channelOverrides.channelId, channel.id),
        eq(channelOverrides.role, role), eq(channelOverrides.permission, permission))).run();
      else tx.insert(channelOverrides).values({ channelId: channel.id, role, permission, allow }).onConflictDoUpdate({
        target: [channelOverrides.channelId, channelOverrides.role, channelOverrides.permission], set: { allow },
      }).run();
      audit(tx, actor.id, "channel.permission_changed", channel.id, { channelName: channel.name, role, permission, allow });
    }, { behavior: "immediate" });
    if (allow === null) overrides.delete(key);
    else overrides.set(key, allow);
    this.overrides.set(channel.id, overrides);
    this.clearPermissionCache();
  }
  private authorizeRolePermissionChange(actor: Account, channel: Channel, role: Role, permission: Permission, affectsDescendants: boolean) {
    this.require(actor, "manageRoles");
    this.require(actor, permission);
    if (this.rank(role) >= this.effectiveRank(actor) || !this.holdsServerGrants(actor, this.roleGrants.get(role))) fail("FORBIDDEN");
    if (actor.roles.includes("Owner")) return;

    const requireScope = (scope: Channel) => {
      this.require(actor, "join", scope);
      this.require(actor, "editChannels", scope);
      this.require(actor, permission, scope);
      for (const grant of inheritedChannelPermissions) {
        if (this.roleAllowed(role, grant, scope)) this.require(actor, grant, scope);
      }
    };
    requireScope(channel);
    if (!affectsDescendants) return;

    // A nearer override shields its channel and subtree from this change.
    const key = `${role}/${permission}`;
    for (const descendant of this.catalog.values()) {
      let current = descendant;
      while (current !== channel && current.parentId && !this.overrides.get(current.id)?.has(key)) {
        current = this.channel(current.parentId);
      }
      if (current === channel && descendant !== channel) requireScope(descendant);
    }
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
      if (current?.id === LOBBY && (payload.password || payload.capacity !== undefined && payload.capacity !== null)) fail("FORBIDDEN");
      if (!current && this.catalog.size >= this.config.limits.max_channels) fail("LIMIT");
      if (current && current.parentId !== parentId) this.authorizeReparent(actor, current, parent);
      else this.validateChannelParent(id, parent);
      return { actor, parentId };
    };
    authorize();
    const image = payload.backgroundImageUrl;
    const backgroundImageUrl = image === undefined ? current?.backgroundImageUrl ?? null : image === null ? null : this.imageUrl(image);
    const icon = payload.icon === undefined ? current?.icon ?? null : payload.icon?.trim() || null;
    const passwordHash = payload.password === undefined ? current?.passwordHash ?? null : payload.password === null ? null :
      await this.password(peer.account!.id, () => Bun.password.hash(payload.password!, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }));
    const { actor, parentId } = authorize();
    if (payload.audioBitrate !== undefined) this.require(actor, "manageSettings");
    const channel = {
      id, parentId, name: payload.name?.trim() ?? current!.name, description: payload.description ?? current?.description ?? "",
      position: payload.position ?? current?.position ?? 0, capacity: payload.capacity !== undefined ? payload.capacity : current?.capacity ?? null,
      temporary: "temporary" in payload ? !!payload.temporary : current?.temporary ?? false, passwordHash, backgroundImageUrl, icon,
      audioBitrate: payload.audioBitrate !== undefined ? payload.audioBitrate : current?.audioBitrate ?? null,
    };
    if (channel.temporary && !current) this.require(actor, "join", channel);
    this.db.transaction((tx) => {
      tx.insert(channels).values(channel).onConflictDoUpdate({ target: channels.id, set: channel }).run();
      audit(tx, actor.id, current ? "channel.edited" : "channel.created", id, { channelName: channel.name });
    }, { behavior: "immediate" });
    this.catalog.set(id, channel);
    this.clearPermissionCache();
    if (channel.temporary && !current) {
      try { this.join(peer, channel); } catch (error) { this.removeChannel(id); throw error; }
    }
    this.recheckAll();
    return { channelId: id, state: this.snapshot(peer) };
  }

  /**
   * Members and outside readers share text access: anyone who may join and use text there,
   * except that a password-protected channel is only readable from inside it.
   */
  private canChat(peer: Peer, channel: Channel) {
    const account = peer.account!;
    return this.canJoin(peer, channel) && this.allowed(account, "text", channel) &&
      (peer.channelId === channel.id || !channel.passwordHash);
  }
  private chatPermissions(peer: Peer, channel: Channel) {
    const canChat = this.canChat(peer, channel);
    return { canChat, canAttachFiles: canChat && this.allowed(peer.account!, "attachFiles", channel),
      messagePins: this.config.messaging.persistence,
      canPinMessages: this.config.messaging.persistence && canChat && this.allowed(peer.account!, "pinMessages", channel) };
  }
  private textChannel(peer: Peer, channelId: string) {
    const channel = this.channel(channelId);
    if (!this.canChat(peer, channel)) fail("FORBIDDEN");
    return channel;
  }
  /** Connections that receive a channel's chat events: its members and its outside readers. */
  private chatAudience(channel: Channel) {
    const audience = new Set([...(this.memberships.get(channel.id) ?? []), ...(this.viewers.get(channel.id) ?? [])]);
    return [...audience].filter((peer) => this.canChat(peer, channel));
  }
  private view(peer: Peer, channelId: string | null) {
    if (channelId) this.textChannel(peer, channelId);
    if (peer.viewChannelId === channelId) return;
    this.unview(peer);
    if (!channelId) return;
    peer.viewChannelId = channelId;
    const viewers = this.viewers.get(channelId) ?? new Set<Peer>();
    viewers.add(peer);
    this.viewers.set(channelId, viewers);
  }
  private unview(peer: Peer, notify = false) {
    const channelId = peer.viewChannelId;
    if (!channelId) return;
    peer.viewChannelId = null;
    const viewers = this.viewers.get(channelId);
    viewers?.delete(peer);
    if (!viewers?.size) this.viewers.delete(channelId);
    if (notify) this.event(peer, "channel.viewEnded", { channelId });
  }
  private history(peer: Peer, payload: { channelId: string; before?: number }) {
    const channel = this.textChannel(peer, payload.channelId);
    if (!this.config.messaging.persistence) return [];
    const rows = this.db.select({ message: messages, attachment: { name: attachments.name, size: attachments.size } })
      .from(messages).leftJoin(attachments, eq(attachments.messageId, messages.id)).where(and(eq(messages.channelId, channel.id), gte(messages.createdAt, this.messageStorage.channelCutoff()),
      payload.before === undefined ? undefined : lt(messages.createdAt, payload.before)))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(100).all();
    return rows.map(({ message, attachment }) => this.messagePayload(message, attachment));
  }
  private pinnedMessages(peer: Peer, { channelId, before }: { channelId: string; before?: { id: string; pinnedAt: number } }) {
    const channel = this.textChannel(peer, channelId);
    if (!this.config.messaging.persistence) return { messages: [], next: null };
    const rows = this.db.select({ id: messages.id, senderId: messages.senderId, createdAt: messages.createdAt, pinnedAt: messages.pinnedAt,
      text: sql<string>`substr(${messages.text}, 1, 240)`, attachmentName: attachments.name })
      .from(messages).leftJoin(attachments, eq(attachments.messageId, messages.id))
      .where(and(eq(messages.channelId, channel.id), gte(messages.createdAt, this.messageStorage.channelCutoff()), isNotNull(messages.pinnedAt),
        before && sql`(${messages.pinnedAt}, ${messages.id}) < (${before.pinnedAt}, ${before.id})`))
      .orderBy(desc(messages.pinnedAt), desc(messages.id)).limit(51).all();
    const page = rows.slice(0, 50);
    const last = page.at(-1);
    return { messages: page, next: rows.length > page.length && last ? { id: last.id, pinnedAt: last.pinnedAt } : null };
  }
  private messageContext(peer: Peer, { channelId, messageId }: { channelId: string; messageId: string }) {
    const channel = this.textChannel(peer, channelId);
    if (!this.config.messaging.persistence) fail("NOT_FOUND");
    const inHistory = and(eq(messages.channelId, channel.id), gte(messages.createdAt, this.messageStorage.channelCutoff()));
    const rows = () => this.db.select({ message: messages, attachment: { name: attachments.name, size: attachments.size } })
      .from(messages).leftJoin(attachments, eq(attachments.messageId, messages.id));
    const anchor = rows().where(and(inHistory, eq(messages.id, messageId))).get();
    if (!anchor) fail("NOT_FOUND");
    const target = this.messagePayload(anchor.message, anchor.attachment);
    const { createdAt } = target;
    const older = rows().where(and(inHistory, sql`(${messages.createdAt}, ${messages.id}) < (${createdAt}, ${messageId})`))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(20).all();
    const newer = rows().where(and(inHistory, sql`(${messages.createdAt}, ${messages.id}) > (${createdAt}, ${messageId})`))
      .orderBy(messages.createdAt, messages.id).limit(20).all();
    // Leave room for the response envelope within the desktop client's 256 KiB frame limit.
    const sideBudget = Math.floor((240 * 1024 - Buffer.byteLength(JSON.stringify(target))) / 2);
    const neighbors = (side: typeof older) => {
      const result: (typeof target)[] = [];
      let bytes = 0;
      for (const { message, attachment } of side) {
        const entry = this.messagePayload(message, attachment);
        bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes > sideBudget) break;
        result.push(entry);
      }
      return result;
    };
    return [...neighbors(older).reverse(), target, ...neighbors(newer)];
  }
  private setMessagePin(peer: Peer, { channelId, messageId, pinned }: { channelId: string; messageId: string; pinned: boolean }) {
    const channel = this.textChannel(peer, channelId);
    const actor = peer.account!;
    this.require(actor, "pinMessages", channel);
    if (!this.config.messaging.persistence) fail("CONFLICT");
    const pinnedAt = this.db.transaction((tx) => {
      const message = tx.select({ pinnedAt: messages.pinnedAt }).from(messages).where(and(eq(messages.id, messageId),
        eq(messages.channelId, channel.id), gte(messages.createdAt, this.messageStorage.channelCutoff()))).get();
      if (!message) fail("NOT_FOUND");
      if (Boolean(message.pinnedAt) === pinned) return undefined;
      const pinnedAt = pinned ? Date.now() : null;
      tx.update(messages).set({ pinnedAt }).where(eq(messages.id, messageId)).run();
      return pinnedAt;
    }, { behavior: "immediate" });
    if (pinnedAt !== undefined) this.broadcast(this.chatAudience(channel), "message.pinChanged", { channelId, messageId, pinnedAt });
    return {};
  }
  private messagePayload({ html, pinnedAt, ...message }: typeof messages.$inferSelect, attachment?: { name: string; size: number } | null) {
    return { ...message, ...(html ? { html } : {}), ...(attachment ? { attachment } : {}), ...(pinnedAt ? { pinnedAt } : {}) };
  }
  private sendMessage(peer: Peer, payload: { channelId: string; text: string; html?: string }, file?: AttachmentData) {
    const senderId = peer.account!.id;
    this.messageRate.take(senderId);
    if (payload.text.length > this.config.messaging.max_length || (!file && !payload.text.trim())) fail("INVALID_REQUEST");
    const channel = this.textChannel(peer, payload.channelId);
    const message = { id: randomUUID(), channelId: channel.id, recipientId: null, senderId, createdAt: Date.now(), editedAt: null, text: payload.text,
      html: payload.text.trim() && payload.html ? sanitizeChatHtml(payload.html) : null, pinnedAt: null };
    if (this.config.messaging.persistence) {
      this.messageStorage.write((tx) => {
        if (file) {
          const used = Number(tx.select({ size: sum(attachments.size) }).from(attachments).get()?.size ?? 0);
          if (used + file.size > this.config.limits.stored_attachment_bytes) fail("LIMIT");
          const usedByAccount = Number(tx.select({ size: sum(attachments.size) }).from(messages)
            .innerJoin(attachments, eq(attachments.messageId, messages.id)).where(eq(messages.senderId, senderId)).get()?.size ?? 0);
          if (usedByAccount + file.size > this.config.limits.stored_attachment_bytes_per_account) fail("LIMIT");
        }
        tx.insert(messages).values(message).run();
        if (file) tx.insert(attachments).values({ messageId: message.id, ...file }).run();
      });
    } else {
      const reference = { id: message.id, channelId: channel.id, senderId, recipientId: null };
      if (file) {
        const usedByAccount = this.liveAttachmentBytesByAccount.get(senderId) ?? 0;
        if (this.liveAttachmentBytes + file.size > Math.max(liveAttachmentLimit, this.maxAttachmentBytes * 4) ||
            usedByAccount + file.size > Math.max(liveAttachmentLimitPerAccount, this.maxAttachmentBytes)) {
          fail("LIMIT");
        }
        this.liveAttachments.set(message.id, { message: reference, file, expiresAt: message.createdAt + liveMessageLifetime });
        this.liveAttachmentBytes += file.size;
        this.liveAttachmentBytesByAccount.set(senderId, usedByAccount + file.size);
      } else this.liveText.add(reference);
    }
    const event = this.messagePayload(message, file && { name: file.name, size: file.size });
    this.broadcast(this.chatAudience(channel), "message.created", event);
    return { messageId: message.id };
  }

  private attachmentPeer(session: Session, connectionId: string) {
    const peer = this.peer(connectionId);
    if (peer.session?.id !== session.id) fail("FORBIDDEN");
    this.verify(peer);
    return peer;
  }

  uploadAttachment(session: Session, payload: typeof httpBodies.attachmentUpload.static) {
    const peer = this.attachmentPeer(session, payload.connectionId);
    const channel = this.textChannel(peer, payload.channelId);
    this.require(peer.account!, "attachFiles", channel);
    const maxBytes = this.maxAttachmentBytes;
    if (payload.data.length > attachmentDataLength(maxBytes)) this.attachmentTooLarge();
    const data = Buffer.from(payload.data, "base64");
    if (data.length > maxBytes) this.attachmentTooLarge();
    if (!data.length || data.toString("base64") !== payload.data || !payload.name.trim()) fail("INVALID_REQUEST");
    return this.sendMessage(peer, payload, { name: payload.name, size: data.length, data });
  }

  attachmentTooLarge(): never {
    throw new ProtocolError("LIMIT", `Attachments are limited to ${this.maxAttachmentMiB} MiB per file.`);
  }

  downloadAttachment(session: Session, connectionId: string, messageId: string) {
    const peer = this.attachmentPeer(session, connectionId);
    const readable = (channelId: string | null) => {
      const channel = channelId ? this.catalog.get(channelId) : undefined;
      return !!channel && this.canChat(peer, channel);
    };
    const live = this.liveAttachment(messageId);
    if (live && readable(live.message.channelId)) {
      this.attachmentDownloadRate.take(session.accountId, live.file.size);
      return { data: live.file.data.toString("base64") };
    }
    if (!this.config.messaging.persistence) fail("NOT_FOUND");
    const stored = this.db.select({ size: attachments.size, channelId: messages.channelId }).from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(and(eq(messages.id, messageId), gte(messages.createdAt, this.messageStorage.channelCutoff())))
      .get();
    if (!stored || !readable(stored.channelId)) fail("NOT_FOUND");
    this.attachmentDownloadRate.take(session.accountId, stored.size);
    const { data } = this.db.select({ data: attachments.data }).from(attachments).where(eq(attachments.messageId, messageId)).get()!;
    return { data: data.toString("base64") };
  }

  private removeLiveAttachment(id: string) {
    const entry = this.liveAttachments.get(id);
    if (!entry) return;
    this.liveAttachmentBytes -= entry.file.size;
    const { senderId } = entry.message;
    const remaining = this.liveAttachmentBytesByAccount.get(senderId)! - entry.file.size;
    if (remaining) this.liveAttachmentBytesByAccount.set(senderId, remaining);
    else this.liveAttachmentBytesByAccount.delete(senderId);
    this.liveAttachments.delete(id);
  }

  private liveAttachment(id: string) {
    const entry = this.liveAttachments.get(id);
    if (entry && entry.expiresAt > Date.now()) return entry;
  }

  private async dispatch(peer: Peer, request: Request) {
    if (request.type === "connection.authenticate") {
      if (peer.account || peer.deadline <= Date.now()) fail("AUTH_FAILED");
      if (!request.payload.versions.includes(1)) fail("VERSION_UNSUPPORTED");
      const session = this.auth.consumeTicket(request.payload.ticket);
      if ((this.kicked.get(session.accountId) ?? 0) > Date.now()) {
        throw new ProtocolError("FORBIDDEN", "You were kicked from this server. Try again in a minute.");
      }
      const group = this.online.get(session.accountId) ?? new Set<Peer>();
      if (group.size >= this.config.limits.connections_per_account || !group.size && this.online.size >= this.config.server.max_users) fail("LIMIT");
      peer.session = session;
      peer.account = this.auth.account(session.accountId);
      peer.connectedAt = performance.now();
      peer.adminMuted = !!this.db.select({ accountId: speakingRestrictions.accountId }).from(speakingRestrictions)
        .where(eq(speakingRestrictions.accountId, session.accountId)).get();
      peer.adminDeafened = !!this.db.select({ accountId: hearingRestrictions.accountId }).from(hearingRestrictions)
        .where(eq(hearingRestrictions.accountId, session.accountId)).get();
      this.releasePending(peer.source);
      group.add(peer);
      this.online.set(session.accountId, group);
      this.connected.set(peer.id, peer);
      this.probeConnection(peer);
      audit(this.db, session.accountId, "connection.opened", null, { connectionId: peer.id });
      this.presenceAccount(session.accountId, peer);
      return this.snapshot(peer);
    }
    const actor = this.verify(peer);
    if (request.type.startsWith("media.")) {
      this.mediaRate.take(actor.id);
      if (request.type === "media.ice.restart") this.iceRate.take(actor.id);
      let whisper: WhisperRoute | undefined;
      if (request.type === "media.transport.create") {
        const { whisperChannelId, whisperPassword, kind, direction } = request.payload;
        if (whisperPassword !== undefined && !whisperChannelId) fail("INVALID_REQUEST");
        if (whisperChannelId) {
          if (kind || direction !== "send") fail("INVALID_REQUEST");
          const channel = this.catalog.get(whisperChannelId);
          if (!channel) fail("FORBIDDEN");
          whisper = { channelId: channel.id, passwordHash: channel.passwordHash };
          if (!this.canWhisper(peer, whisper)) fail("FORBIDDEN");
          const { passwordHash } = whisper;
          if (passwordHash && (!whisperPassword || !await this.password(actor.id, () => Bun.password.verify(whisperPassword, passwordHash)))) {
            fail("FORBIDDEN");
          }
        }
      }
      return this.media.handle(peer, request as Extract<Request, { type: `media.${string}` }>, (send, receive) => {
        const current = this.verify(peer);
        const channel = this.channelMember(peer);
        if (!this.canJoin(peer, channel)) fail("FORBIDDEN");
        if (send) {
          if (!this.canSpeak(peer, channel)) fail("FORBIDDEN");
          if (send !== "audio") this.require(current, videoPermissions[send], channel);
          if ((send === "audio" && peer.muted) || peer.adminMuted || peer.placementMuted || peer.deafened || peer.adminDeafened || peer.afk) fail("FORBIDDEN");
        }
        if (receive && (peer.deafened || peer.adminDeafened || peer.afk)) fail("FORBIDDEN");
      }, (route) => this.canWhisper(peer, route), whisper);
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
        this.require(actor, "removeChannels", channel);
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
            (!password || !await this.password(actor.id, () => Bun.password.verify(password, channel.passwordHash!)))) {
          throw new ProtocolError("FORBIDDEN", "Incorrect channel password.");
        }
        const current = this.verify(peer);
        if (this.channel(channelId) !== channel) fail("CONFLICT");
        this.require(current, "join", channel);
        this.join(peer, channel);
        return this.snapshot(peer);
      }
      case "channel.leave": this.leave(peer); return this.snapshot(peer);
      case "channel.view": this.view(peer, request.payload.channelId); break;
      case "channel.move": {
        const { payload } = request;
        const ids = "connectionIds" in payload ? new Set(payload.connectionIds) : [payload.connectionId];
        const targets = Array.from(ids, (id) => this.peer(id));
        const channel = this.channel(payload.channelId);
        this.require(actor, "move", channel);
        for (const target of targets) {
          if (target.channelId) this.require(actor, "move", this.channelMember(target));
          this.subordinate(actor, target.account!);
        }
        this.requireChannelCapacity(channel, targets.filter((target) => target.channelId !== channel.id).length);
        for (const target of targets) {
          if (target.channelId !== channel.id) {
            this.join(target, channel);
            if (!this.allowed(target.account!, "join", channel) || !this.allowed(target.account!, "speak", channel)) {
              target.placedChannelId = channel.id;
              target.placementMuted = true;
              this.media.stopSending(target.id);
              this.memberChanged(target);
            }
            audit(this.db, actor.id, "channel.moved", target.account!.id, { channelId: channel.id, channelName: channel.name });
          }
          this.event(target, "channel.changed", { channelId: channel.id });
        }
        break;
      }
      case "presence.set": {
        const { muted, deafened, afk, afkMessage } = request.payload;
        peer.muted = muted ?? peer.muted;
        peer.deafened = deafened ?? peer.deafened;
        peer.afk = afk ?? peer.afk;
        if (afkMessage !== undefined) peer.afkMessage = afkMessage.trim();
        const member = this.member(peer);
        if (member.deafened) this.media.stopSending(peer.id);
        else if (member.muted) this.media.stopSending(peer.id, "audio");
        if (member.deafened) this.media.stopReceiving(peer.id);
        this.memberChanged(peer);
        return member;
      }
      case "role.add": return this.addRole(actor, request.payload.accountId, request.payload.role);
      case "role.remove": return this.removeRole(actor, request.payload.accountId, request.payload.role);
      case "channel.override": {
        const { channelId, ...change } = request.payload;
        this.overrideChannel(actor, this.channel(channelId), change);
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
          const existing = tx.select({ actorId: table.actorId }).from(table).where(eq(table.accountId, accountId)).get();
          if (existing && !actor.roles.includes("Owner") &&
              this.effectiveRank(actor) < this.effectiveRank(this.auth.account(existing.actorId))) fail("FORBIDDEN");
          if (restricted) tx.insert(table).values({ accountId, actorId: actor.id })
            .onConflictDoUpdate({ target: table.accountId, set: { actorId: actor.id } }).run();
          else tx.delete(table).where(eq(table.accountId, accountId)).run();
          audit(tx, actor.id, action, accountId);
        }, { behavior: "immediate" });
        for (const connection of [...(this.online.get(accountId) ?? [])]) {
          if (deafen) connection.adminDeafened = restricted;
          else {
            connection.adminMuted = restricted;
            if (!restricted) connection.placementMuted = false;
          }
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
        const target = this.auth.account(accountId);
        if (request.type === "moderation.kick") this.subordinate(actor, target);
        else if (!this.canBan(actor, target)) fail("FORBIDDEN");
        if (request.type === "moderation.ban") {
          const seconds = request.payload.expiresInSeconds;
          this.auth.ban(actor.id, accountId, seconds ? Date.now() + seconds * 1000 : null);
        } else {
          this.db.transaction((tx) => {
            if (request.type === "moderation.unban") tx.delete(bans).where(eq(bans.accountId, accountId)).run();
            audit(tx, actor.id, request.type, accountId);
          }, { behavior: "immediate" });
          if (request.type === "moderation.kick") {
            // A short cooldown stops the client from reconnecting straight away.
            this.kicked.set(accountId, Date.now() + kickSeconds * 1000);
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
      case "invitation.update": {
        this.require(actor, "manageInvitations");
        const { invitationId, ...changes } = request.payload;
        return this.auth.updateInvitation(actor, invitationId, changes);
      }
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
        return this.db.select({ id: auditEvents.id, actorId: auditEvents.actorId, action: auditEvents.action,
          targetId: auditEvents.targetId, createdAt: auditEvents.createdAt }).from(auditEvents)
          .where(request.payload.before ? lt(auditEvents.id, request.payload.before) : undefined)
          .orderBy(desc(auditEvents.id)).limit(100).all();
      case "server.settings": {
        this.require(actor, "manageSettings");
        const trimmed = request.payload.name?.trim();
        if (trimmed !== undefined && process.env.VOICE_SERVER_NAME !== undefined) fail("FORBIDDEN");
        this.db.transaction((tx) => {
          if (trimmed !== undefined) {
            tx.insert(settings).values({ key: "name", value: trimmed })
              .onConflictDoUpdate({ target: settings.key, set: { value: trimmed } }).run();
          }
          audit(tx, actor.id, "server.settings_changed", null);
        }, { behavior: "immediate" });
        if (trimmed !== undefined) this.config.server.name = trimmed;
        this.broadcastAll("server.changed", { name: this.config.server.name, registration: this.config.server.registration });
        break;
      }
      case "message.send": return this.sendMessage(peer, request.payload);
      case "message.history": return this.history(peer, request.payload);
      case "message.context": return this.messageContext(peer, request.payload);
      case "message.pins": return this.pinnedMessages(peer, request.payload);
      case "message.pin": return this.setMessagePin(peer, request.payload);
      case "direct.peer": return this.directMessages.identities(actor.id, request.payload.accountId);
      case "direct.inbox": return this.directMessages.inbox(actor.id);
      case "direct.history": return this.directMessages.history(actor.id, request.payload.accountId, request.payload.before);
      case "direct.send": {
        const { accountId, id } = request.payload;
        this.require(actor, "sendDirectMessages");
        this.messageRate.take(actor.id);
        this.directMessages.peer(actor.id, accountId);
        if (isBanned(this.db, accountId)) fail("NOT_FOUND");
        const recipients = this.activeDevices(accountId);
        const message = this.directMessages.send(actor.id, request.payload, recipients.length > 0);
        if (message) this.broadcast([...this.activeDevices(actor.id), ...recipients], "direct.created", message);
        return { messageId: id, queued: !recipients.length };
      }
      case "direct.edit": {
        const { accountId } = request.payload;
        this.require(actor, "sendDirectMessages");
        this.messageRate.take(actor.id);
        const recipients = this.activeDevices(accountId);
        const message = this.directMessages.edit(actor.id, request.payload, recipients.length > 0);
        this.broadcast([...this.activeDevices(actor.id), ...recipients], "direct.edited", message);
        return {};
      }
      case "direct.delete": {
        const { accountId, id } = request.payload;
        this.require(actor, "sendDirectMessages");
        this.messageRate.take(actor.id);
        const recipients = this.activeDevices(accountId);
        this.directMessages.delete(actor.id, accountId, id, recipients.length > 0);
        this.broadcast([...this.activeDevices(actor.id), ...recipients], "direct.deleted", { id, senderId: actor.id, recipientId: accountId });
        return {};
      }
      case "direct.pending": return this.directMessages.pending(actor.id);
      case "direct.ack": {
        this.directMessages.acknowledge(actor.id, request.payload.ids);
        break;
      }
      case "direct.poke": {
        const { accountId, message } = request.payload;
        this.require(actor, "sendDirectMessages");
        if (actor.id === accountId) fail("INVALID_REQUEST");
        this.pokeRate.take(actor.id);
        const recipients = this.activeDevices(accountId);
        if (!recipients.length || isBanned(this.db, accountId)) {
          throw new ProtocolError("CONFLICT", "The recipient is offline.");
        }
        this.broadcast(recipients, "direct.poked", {
          id: randomUUID(), senderId: actor.id, senderName: actor.displayName, recipientId: accountId,
          message: message?.trim() || undefined,
        });
        return {};
      }
      case "message.edit": {
        const { messageId, text, html } = request.payload;
        this.messageRate.take(actor.id);
        const attachment = this.liveAttachment(messageId);
        const live = attachment?.message ?? this.liveText.get(messageId);
        const stored = this.config.messaging.persistence
          ? this.db.select().from(messages).where(eq(messages.id, messageId)).get()
          : undefined;
        const message = live ?? stored ?? fail("NOT_FOUND");
        if (!message.channelId || message.senderId !== actor.id) fail("NOT_FOUND");
        const channel = this.textChannel(peer, message.channelId);
        const hasFile = Boolean(attachment) || Boolean(stored &&
          this.db.select({ id: attachments.messageId }).from(attachments).where(eq(attachments.messageId, messageId)).get());
        if (text.length > this.config.messaging.max_length || (!hasFile && !text.trim())) fail("INVALID_REQUEST");
        const edited = { text, html: text.trim() && html ? sanitizeChatHtml(html) : null, editedAt: Date.now() };
        if (stored) {
          this.messageStorage.write((tx) => tx.update(messages).set(edited).where(eq(messages.id, messageId)).run());
        }
        this.broadcast(this.chatAudience(channel),
          "message.edited", { messageId, ...(stored ? { channelId: channel.id } : {}), text: edited.text, html: edited.html ?? undefined, editedAt: edited.editedAt });
        break;
      }
      case "message.delete": {
        const { messageId } = request.payload;
        const attachment = this.liveAttachment(messageId);
        const live = attachment?.message ?? this.liveText.get(messageId);
        const message = live ?? this.db.select().from(messages).where(eq(messages.id, messageId)).get() ?? fail("NOT_FOUND");
        if (message.channelId) {
          const channel = this.channel(message.channelId);
          if (!this.canJoin(peer, channel) || (peer.channelId !== channel.id && !this.canChat(peer, channel))) fail("NOT_FOUND");
          if (message.senderId !== actor.id) this.require(actor, "deleteChannels", channel);
        } else if (message.senderId !== actor.id) fail("NOT_FOUND");
        this.db.transaction((tx) => {
          if (!live) tx.delete(messages).where(eq(messages.id, message.id)).run();
          audit(tx, actor.id, "message.deleted", message.id);
        }, { behavior: "immediate" });
        if (attachment) this.removeLiveAttachment(message.id);
        else this.liveText.delete(message.id);
        const event = { messageId: message.id, ...(!live && message.channelId ? { channelId: message.channelId } : {}) };
        if (message.channelId) {
          const channel = this.channel(message.channelId);
          this.broadcast(new Set([...(this.memberships.get(channel.id) ?? []), ...this.chatAudience(channel)]), "message.deleted", event);
        }
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
