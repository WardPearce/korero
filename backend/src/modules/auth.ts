import { and, count, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { Config } from "../config";
import { audit, DEFAULT_ROLE_KEY, INITIAL_ROLE, type Queries, type Role, type Store } from "../database";
import { accountIdentities, accounts, accountRoles, bans, invitations, profilePictures, refreshHistory, sessions, settings, setup } from "../database/schema";
import { maxProfilePictureBytes } from "../protocol";
import { Credentials, equalDigest, randomToken } from "../security/credentials";
import { fail, ProtocolError, RateLimit } from "../security/errors";
import { PasswordWork } from "../security/work";

export type Account = typeof accounts.$inferSelect & { role: Role; avatarId: string | null };
const { accessDigest: _, ...sessionColumns } = getTableColumns(sessions);
export type Session = Omit<typeof sessions.$inferSelect, "accessDigest">;
type IdentityOperation = "login" | "register" | "bootstrap";
type IdentityProof = { id: string; signature: string };
type IdentityChallenge = {
  publicKey: string; operation: IdentityOperation;
  deviceName: string; serverId: string; origin: string; expiresAt: number;
};
type Ticket = { sessionId: string; accountId: string; expiresAt: number };
type RevokedSession = { id: string };

const invitationRow = sqliteTable("invitations", { rowId: integer("rowid") });
const invitationDetails = {
  id: invitations.id, createdBy: invitations.createdBy, expiresAt: invitations.expiresAt,
  usesLeft: invitations.usesLeft, revokedAt: invitations.revokedAt,
};
const passwordKey = "serverPasswordHash";
const maxIdentityChallenges = 512;
const maxIdentityChallengesPerSource = 16;
const passwordOptions = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodeProfilePicture(encoded: string) {
  const image = Buffer.from(encoded, "base64");
  const invalid = () => { throw new ProtocolError("INVALID_REQUEST", "Use a PNG profile picture up to 192 pixels per side."); };
  if (image.length > maxProfilePictureBytes || image.length < 45 || image.toString("base64") !== encoded ||
      !image.subarray(0, 8).equals(pngSignature) || image.readUInt32BE(8) !== 13 ||
      image.toString("ascii", 12, 16) !== "IHDR") return invalid();
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (!width || !height || width > 192 || height > 192) return invalid();
  let hasImageData = false;
  for (let offset = 8; offset + 12 <= image.length;) {
    const size = image.readUInt32BE(offset);
    const end = offset + 8 + size;
    if (end + 4 > image.length ||
        Bun.hash.crc32(image.subarray(offset + 4, end)) !== image.readUInt32BE(end)) return invalid();
    const type = image.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT" && size > 0) hasImageData = true;
    if (type === "IEND") return hasImageData && size === 0 && end + 4 === image.length ? image : invalid();
    offset = end + 4;
  }
  return invalid();
}

function invitationScope(actor: Account) {
  return actor.role === "Administrator" || actor.role === "Owner" ? undefined : eq(invitations.createdBy, actor.id);
}

function getAccount(db: Queries, id: string): Account {
  const row = db.select({ ...getTableColumns(accounts), role: accountRoles.role, avatarId: profilePictures.revision })
    .from(accounts).innerJoin(accountRoles, eq(accounts.id, accountRoles.accountId))
    .leftJoin(profilePictures, eq(accounts.id, profilePictures.accountId)).where(eq(accounts.id, id)).get();
  if (!row) fail("NOT_FOUND");
  return row;
}

function hasOwner(db: Queries) {
  return !!db.select({ id: accountRoles.accountId }).from(accountRoles).where(eq(accountRoles.role, "Owner")).limit(1).get();
}

function activeAt(now: number) { return and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now)); }

function findSession(db: Queries, condition: SQL, now = Date.now()) {
  return db.select(sessionColumns).from(sessions).where(and(condition, activeAt(now))).get();
}

export function isBanned(db: Queries, accountId: string) {
  return !!db.select({ id: bans.accountId }).from(bans)
    .where(and(eq(bans.accountId, accountId), or(isNull(bans.expiresAt), gt(bans.expiresAt, Date.now())))).get();
}

export class Auth {
  private readonly identityChallenges = new Map<string, IdentityChallenge & { source: string }>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly ticketsByAccount = new Map<string, number>();
  private readonly refreshRate: RateLimit;
  private readonly ticketRate: RateLimit;
  readonly passwordLocked = process.env.VOICE_SERVER_PASSWORD !== undefined;
  private readonly environmentPasswordHash?: string;
  private readonly passwordWork = new PasswordWork();
  onRevoked: (sessionIds: Set<string>) => void = () => {};
  onAccountChanged: (accountId: string) => void = () => {};
  onAccountCreated: () => void = () => {};
  constructor(private readonly db: Store, private readonly credentials: Credentials, private readonly config: Config) {
    this.refreshRate = new RateLimit(Math.max(4, config.limits.auth_per_minute));
    this.ticketRate = new RateLimit(Math.max(config.limits.connections_per_account, config.limits.auth_per_minute));
    if (this.passwordLocked && config.server.password) {
      this.environmentPasswordHash = Bun.password.hashSync(config.server.password, passwordOptions);
    }
  }

  account(id: string) { return getAccount(this.db, id); }
  updateAccount(id: string, displayName: string) {
    const previous = this.account(id);
    if (previous.displayName === displayName) return previous;
    this.db.transaction((tx) => {
      tx.update(accounts).set({ displayName }).where(eq(accounts.id, id)).run();
      audit(tx, id, "account.profile_changed", id, { previousName: previous.displayName, displayName });
    }, { behavior: "immediate" });
    this.onAccountChanged(id);
    return { ...previous, displayName };
  }

  profilePicture(accountId: string) {
    const picture = this.db.select().from(profilePictures).where(eq(profilePictures.accountId, accountId)).get();
    return picture ? { avatarId: picture.revision, data: picture.data.toString("base64") } : { avatarId: null, data: null };
  }

  updateProfilePicture(accountId: string, encoded: string | null) {
    const data = encoded === null ? null : decodeProfilePicture(encoded);
    const avatarId = data ? randomUUID() : null;
    if (data && avatarId) {
      this.db.insert(profilePictures).values({ accountId, revision: avatarId, data })
        .onConflictDoUpdate({ target: profilePictures.accountId, set: { revision: avatarId, data } }).run();
    } else if (!this.db.delete(profilePictures).where(eq(profilePictures.accountId, accountId))
      .returning({ accountId: profilePictures.accountId }).get()) {
      return { avatarId };
    }
    this.onAccountChanged(accountId);
    return { avatarId };
  }

  hasOwner() { return hasOwner(this.db); }

  private passwordHash() {
    if (this.passwordLocked) return this.environmentPasswordHash;
    return this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, passwordKey)).get()?.value;
  }

  passwordRequired() { return Boolean(this.passwordHash()); }

  /** Checks the server password, if one is set. `client` identifies the caller for fair queueing. */
  async verifyPassword(client: string, password?: string) {
    const hash = this.passwordHash();
    if (hash && (!password || !await this.passwordWork.run(client, () => Bun.password.verify(password, hash)))) fail("AUTH_FAILED");
    return hash;
  }

  async setServerPassword(authorize: () => Account, password: string | null) {
    if (this.passwordLocked) throw new ProtocolError("FORBIDDEN", "The server password is managed by the host.");
    const previous = this.passwordHash();
    const hash = password === null ? null :
      await this.passwordWork.run(authorize().id, () => Bun.password.hash(password, passwordOptions));
    const actor = authorize();
    this.db.transaction((tx) => {
      if (this.passwordHash() !== previous) fail("CONFLICT");
      if (hash === null) tx.delete(settings).where(eq(settings.key, passwordKey)).run();
      else tx.insert(settings).values({ key: passwordKey, value: hash })
        .onConflictDoUpdate({ target: settings.key, set: { value: hash } }).run();
      audit(tx, actor.id, "server.password_changed", null);
    }, { behavior: "immediate" });
    return { passwordRequired: hash !== null };
  }

  syncConfiguredServerPassword(password: string) {
    const previous = this.passwordHash();
    if (previous && Bun.password.verifySync(password, previous)) return;
    const hash = Bun.password.hashSync(password, passwordOptions);
    this.db.transaction((tx) => {
      if (this.passwordHash() !== previous) fail("CONFLICT");
      tx.insert(settings).values({ key: passwordKey, value: hash })
        .onConflictDoUpdate({ target: settings.key, set: { value: hash } }).run();
      audit(tx, null, "server.password_changed", null);
    }, { behavior: "immediate" });
  }

  issueSetup(renew = false) {
    return this.db.transaction((tx) => {
      if (hasOwner(tx)) {
        if (renew) fail("CONFLICT");
        return null;
      }
      if (!renew && tx.select({ id: setup.id }).from(setup).where(eq(setup.id, 1)).get()) return null;
      const token = randomToken();
      const expiresAt = Date.now() + this.config.authentication.setup_seconds * 1000;
      const fields = { digest: this.credentials.digest("setup", token), expiresAt };
      tx.insert(setup).values({ id: 1, ...fields }).onConflictDoUpdate({ target: setup.id, set: fields }).run();
      audit(tx, null, "setup.issued", null);
      return { token, expiresAt };
    }, { behavior: "immediate" });
  }

  async bootstrap(client: string, token: string, name: string, device: string, identity: IdentityChallenge, password?: string) {
    if (hasOwner(this.db)) fail("NOT_FOUND");
    const hash = await this.verifyPassword(client, password);
    const { result, created } = this.db.transaction((tx) => {
      if (hasOwner(tx)) fail("NOT_FOUND");
      if (this.passwordHash() !== hash) fail("CONFLICT");
      const row = tx.select().from(setup).where(eq(setup.id, 1)).get();
      if (!row || row.expiresAt <= Date.now() || !equalDigest(row.digest, this.credentials.digest("setup", token))) fail("AUTH_FAILED");
      tx.delete(setup).where(eq(setup.id, row.id)).run();
      const existing = tx.select({ accountId: accountIdentities.accountId }).from(accountIdentities)
        .where(eq(accountIdentities.publicKey, identity.publicKey)).get();
      if (existing) {
        if (isBanned(tx, existing.accountId)) fail("FORBIDDEN");
        tx.update(accountRoles).set({ role: "Owner" }).where(eq(accountRoles.accountId, existing.accountId)).run();
        audit(tx, existing.accountId, "setup.consumed", existing.accountId);
        return { created: false, result: { account: getAccount(tx, existing.accountId), ...this.createSession(tx, existing.accountId, device) } };
      }
      const result = this.createAccount(tx, name, device, "Owner", identity);
      audit(tx, result.account.id, "setup.consumed", result.account.id);
      return { created: true, result };
    }, { behavior: "immediate" });
    if (created) this.onAccountCreated();
    else this.onAccountChanged(result.account.id);
    return result;
  }

  async register(client: string, name: string, device: string, identity: IdentityChallenge, invitation?: string, password?: string) {
    if (this.config.server.registration === "disabled") fail("FORBIDDEN");
    const hash = invitation ? undefined : await this.verifyPassword(client, password);
    const result = this.db.transaction((tx) => {
      if (!invitation && this.passwordHash() !== hash) fail("CONFLICT");
      const mode = this.config.server.registration;
      if (mode === "disabled") fail("FORBIDDEN");
      if (mode !== "open" && !invitation) fail("AUTH_FAILED");
      let invitationId: string | null = null;
      if (invitation) {
        const now = Date.now();
        const row = tx.select({ id: invitations.id, usesLeft: invitations.usesLeft }).from(invitations).where(and(
          eq(invitations.digest, this.credentials.digest("invitation", invitation)),
          isNull(invitations.revokedAt),
          or(isNull(invitations.expiresAt), gt(invitations.expiresAt, now)),
          or(isNull(invitations.usesLeft), gt(invitations.usesLeft, 0)),
          mode === "admin" ? eq(invitations.adminOnly, true) : undefined,
        )).get();
        if (!row) fail("AUTH_FAILED");
        invitationId = row.id;
        if (row.usesLeft !== null) tx.update(invitations).set({ usesLeft: row.usesLeft - 1 }).where(eq(invitations.id, row.id)).run();
      }
      const role = tx.select({ value: settings.value }).from(settings).where(eq(settings.key, DEFAULT_ROLE_KEY)).get()?.value ?? INITIAL_ROLE;
      const result = this.createAccount(tx, name, device, role, identity, invitationId !== null);
      audit(tx, result.account.id, "account.registered", result.account.id, { role, invitationId });
      return result;
    }, { behavior: "immediate" });
    this.onAccountCreated();
    return result;
  }

  private createAccount(db: Queries, name: string, device: string, role: Role, { publicKey, origin }: IdentityChallenge,
    joinedViaInvitation = false) {
    const length = Array.from(name).length;
    if (length < 4 || length > 32) fail("INVALID_REQUEST");
    if (db.select().from(accountIdentities).where(eq(accountIdentities.publicKey, publicKey)).get()) fail("CONFLICT");
    const id = randomUUID();
    const createdAt = Date.now();
    db.insert(accounts).values({ id, displayName: name, createdAt }).run();
    db.insert(accountRoles).values({ accountId: id, role }).run();
    db.insert(accountIdentities).values({ accountId: id, publicKey, origin, joinedViaInvitation }).run();
    audit(db, id, "identity.attached", id);
    return { account: { id, displayName: name, role, createdAt, badge: null, avatarId: null }, ...this.createSession(db, id, device) };
  }

  challengeIdentity(source: string, serverId: string, operation: IdentityOperation, publicKey: string, deviceName: string, origin: string) {
    const now = Date.now();
    let pending = 0;
    for (const [id, challenge] of this.identityChallenges) {
      if (challenge.expiresAt <= now) this.identityChallenges.delete(id);
      else if (challenge.source === source) pending++;
    }
    if (pending >= maxIdentityChallengesPerSource || this.identityChallenges.size >= maxIdentityChallenges) fail("RATE_LIMITED");
    const id = randomToken();
    if (operation === "login") {
      origin = this.db.select({ origin: accountIdentities.origin }).from(accountIdentities)
        .where(eq(accountIdentities.publicKey, publicKey)).get()?.origin ?? origin;
    }
    const challenge = { serverId, operation, publicKey, deviceName, origin, expiresAt: now + 60_000 };
    this.identityChallenges.set(id, { ...challenge, source });
    return { id, ...challenge, binding: "" };
  }

  private proveIdentity(serverId: string, operation: IdentityOperation, id: string, signature: string) {
    const challenge = this.identityChallenges.get(id);
    if (!challenge || challenge.serverId !== serverId || challenge.operation !== operation ||
        challenge.expiresAt <= Date.now()) fail("AUTH_FAILED");
    this.identityChallenges.delete(id);
    const { publicKey, deviceName, expiresAt, origin } = challenge;
    const raw = Buffer.from(publicKey, "base64url");
    const proof = Buffer.from(signature, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== publicKey || proof.length !== 64) fail("AUTH_FAILED");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    const transcript = JSON.stringify(["korero-identity-v1", serverId, origin, operation, id, publicKey, "", deviceName, expiresAt]);
    if (!verify(null, Buffer.from(transcript), key, proof)) fail("AUTH_FAILED");
    return challenge;
  }

  proveEnrollment(serverId: string, operation: "register" | "bootstrap", deviceName: string, proof: IdentityProof) {
    const challenge = this.proveIdentity(serverId, operation, proof.id, proof.signature);
    if (challenge.deviceName !== deviceName) fail("AUTH_FAILED");
    return challenge;
  }

  async loginIdentity(client: string, serverId: string, id: string, signature: string, password?: string) {
    const { publicKey, deviceName } = this.proveIdentity(serverId, "login", id, signature);
    // Look the identity up first so a throwaway key cannot be used to test server passwords.
    const identity = this.db.select({ joinedViaInvitation: accountIdentities.joinedViaInvitation }).from(accountIdentities)
      .where(eq(accountIdentities.publicKey, publicKey)).get();
    if (!identity) fail("NOT_FOUND");
    const hash = identity.joinedViaInvitation ? undefined : await this.verifyPassword(client, password);
    return this.db.transaction((tx) => {
      const row = tx.select().from(accountIdentities).where(eq(accountIdentities.publicKey, publicKey)).get();
      if (!row) fail("NOT_FOUND");
      if (!row.joinedViaInvitation && this.passwordHash() !== hash) fail("CONFLICT");
      if (isBanned(tx, row.accountId)) fail("FORBIDDEN");
      return { account: getAccount(tx, row.accountId), ...this.createSession(tx, row.accountId, deviceName) };
    }, { behavior: "immediate" });
  }

  private createSession(db: Queries, accountId: string, deviceName: string) {
    const now = Date.now();
    const active = db.select({ total: count() }).from(sessions).where(and(eq(sessions.accountId, accountId), activeAt(now))).get()!;
    if (active.total >= this.config.authentication.max_sessions) fail("LIMIT");
    const sessionId = randomUUID();
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.authentication.access_seconds * 1000;
    const refreshExpiresAt = now + this.config.authentication.refresh_seconds * 1000;
    db.insert(sessions).values({
      id: sessionId, accountId, deviceName, createdAt: now, lastActive: now, expiresAt: refreshExpiresAt,
      accessDigest: this.credentials.digest("access", accessToken), accessExpires: accessExpiresAt,
      refreshDigest: this.credentials.digest("refresh", refreshToken),
    }).run();
    return { sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }

  getSession(id: string) { return findSession(this.db, eq(sessions.id, id)); }
  access(header?: string | null) {
    const token = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    if (!token) fail("AUTH_FAILED");
    const now = Date.now();
    const session = this.db.select(sessionColumns).from(sessions).where(and(
      eq(sessions.accessDigest, this.credentials.digest("access", token)), gt(sessions.accessExpires, now), activeAt(now),
    )).get();
    if (!session || isBanned(this.db, session.accountId)) fail("AUTH_FAILED");
    this.touch(session, now);
    return session;
  }

  touch(session: Session, now = Date.now()) {
    if (now - session.lastActive < 60000) return;
    this.db.update(sessions).set({ lastActive: now }).where(and(eq(sessions.id, session.id), lte(sessions.lastActive, now - 60000))).run();
    session.lastActive = now;
  }

  refresh(token: string, limitInvalid: () => void) {
    const result = this.db.transaction((tx) => {
      const now = Date.now();
      const old = this.credentials.digest("refresh", token);
      const session = findSession(tx, eq(sessions.refreshDigest, old), now);
      const previous = session ? undefined : tx.select().from(refreshHistory).where(eq(refreshHistory.digest, old)).get();
      const active = session ?? (previous && findSession(tx, eq(sessions.id, previous.sessionId), now));
      if (!active || isBanned(tx, active.accountId)) {
        limitInvalid();
        fail("AUTH_FAILED");
      }
      if (previous && now - previous.replacedAt > this.config.authentication.refresh_retry_seconds * 1000) {
        const revoked = this.markRevoked(tx, eq(sessions.id, active.id));
        audit(tx, active.accountId, "session.reuse_detected", active.id);
        return { ok: false as const, revoked };
      }
      this.refreshRate.take(active.id);
      const credentials = {
        accessToken: this.credentials.successor("access", token),
        refreshToken: this.credentials.successor("refresh", token),
      };
      if (session) {
        const accessExpiresAt = now + this.config.authentication.access_seconds * 1000;
        const refreshExpiresAt = now + this.config.authentication.refresh_seconds * 1000;
        const successorDigest = this.credentials.digest("refresh", credentials.refreshToken);
        tx.insert(refreshHistory).values({ digest: old, sessionId: session.id, replacedAt: now, successorDigest }).run();
        tx.update(sessions).set({
          refreshDigest: successorDigest, accessDigest: this.credentials.digest("access", credentials.accessToken),
          accessExpires: accessExpiresAt, expiresAt: refreshExpiresAt, lastActive: now,
        }).where(eq(sessions.id, session.id)).run();
        return { ok: true as const, credentials: { sessionId: session.id, ...credentials, accessExpiresAt, refreshExpiresAt } };
      }
      if (!previous || !equalDigest(active.refreshDigest, previous.successorDigest)) fail("REFRESH_RETRY");
      return { ok: true as const, credentials: {
        sessionId: active.id, ...credentials, accessExpiresAt: active.accessExpires, refreshExpiresAt: active.expiresAt,
      } };
    });
    if (!result.ok) { this.notifyRevoked(result.revoked); fail("AUTH_FAILED"); }
    return result.credentials;
  }

  private markRevoked(db: Queries, ...filters: (SQL | undefined)[]) {
    return db.update(sessions).set({ revokedAt: Date.now() }).where(and(isNull(sessions.revokedAt), ...filters))
      .returning({ id: sessions.id }).all();
  }
  private notifyRevoked(rows: RevokedSession[]) {
    if (!rows.length) return;
    const ids = new Set(rows.map(({ id }) => id));
    for (const [digest, ticket] of this.tickets) if (ids.has(ticket.sessionId)) this.deleteTicket(digest, ticket);
    this.onRevoked(ids);
  }

  revoke(accountId: string, sessionId?: string, actorId = accountId) {
    const revoked = this.db.transaction((tx) => {
      const rows = this.markRevoked(tx, eq(sessions.accountId, accountId), sessionId ? eq(sessions.id, sessionId) : undefined);
      if (rows.length) audit(tx, actorId, sessionId ? "session.revoked" : "sessions.revoked_all", sessionId ?? accountId);
      return rows;
    }, { behavior: "immediate" });
    this.notifyRevoked(revoked);
  }

  ban(actorId: string, accountId: string, expiresAt: number | null) {
    const revoked = this.db.transaction((tx) => {
      const values = { accountId, actorId, expiresAt };
      tx.insert(bans).values(values).onConflictDoUpdate({ target: bans.accountId, set: { actorId, expiresAt } }).run();
      const rows = this.markRevoked(tx, eq(sessions.accountId, accountId));
      audit(tx, actorId, "moderation.ban", accountId);
      return rows;
    }, { behavior: "immediate" });
    this.notifyRevoked(revoked);
  }

  listSessions(accountId: string) {
    const { id, deviceName, createdAt, lastActive, expiresAt } = sessions;
    return this.db.select({ id, deviceName, createdAt, lastActive, expiresAt }).from(sessions)
      .where(and(eq(sessions.accountId, accountId), activeAt(Date.now()))).orderBy(createdAt).all();
  }

  sweep(now: number, persistent: boolean) {
    for (const [digest, ticket] of this.tickets) if (ticket.expiresAt <= now) this.deleteTicket(digest, ticket);
    if (persistent) {
      const expired = this.db.select({ id: sessions.id }).from(sessions)
        .where(or(lte(sessions.expiresAt, now), isNotNull(sessions.revokedAt))).limit(1000);
      this.db.delete(sessions).where(inArray(sessions.id, expired)).run();
    }
  }

  ticket(session: Session) {
    const { accountId, id: sessionId } = session;
    this.ticketRate.take(accountId);
    this.sweep(Date.now(), false);
    const totalLimit = Math.max(64, this.config.server.max_users * 8);
    const accountLimit = Math.min(totalLimit / 2, Math.max(8, this.config.limits.connections_per_account * 2));
    const pending = this.ticketsByAccount.get(accountId) ?? 0;
    if (this.tickets.size >= totalLimit || pending >= accountLimit) fail("LIMIT");
    const ticket = randomToken();
    const expiresAt = Date.now() + this.config.authentication.ticket_seconds * 1000;
    this.tickets.set(this.credentials.digest("ticket", ticket), { sessionId, accountId, expiresAt });
    this.ticketsByAccount.set(accountId, pending + 1);
    return { ticket, expiresAt };
  }

  private deleteTicket(digest: string, { accountId }: Ticket) {
    this.tickets.delete(digest);
    const remaining = this.ticketsByAccount.get(accountId)! - 1;
    if (remaining) this.ticketsByAccount.set(accountId, remaining);
    else this.ticketsByAccount.delete(accountId);
  }

  consumeTicket(token: string) {
    const digest = this.credentials.digest("ticket", token);
    const ticket = this.tickets.get(digest);
    if (!ticket) fail("AUTH_FAILED");
    this.deleteTicket(digest, ticket);
    if (ticket.expiresAt <= Date.now()) fail("AUTH_FAILED");
    const session = this.getSession(ticket.sessionId);
    if (!session || isBanned(this.db, session.accountId)) fail("AUTH_FAILED");
    return session;
  }

  invitation(actor: Account, expiresInSeconds?: number, uses?: number, expiresAt?: number) {
    const adminOnly = actor.role === "Administrator" || actor.role === "Owner";
    if (this.config.server.registration === "admin" && !adminOnly) fail("FORBIDDEN");
    const now = Date.now();
    if (expiresAt !== undefined && (expiresInSeconds !== undefined || expiresAt <= now)) {
      throw new ProtocolError("INVALID_REQUEST", "Choose a future expiration date.");
    }
    const expiration = expiresAt ?? (expiresInSeconds ? now + expiresInSeconds * 1000 : null);
    const token = randomToken();
    const id = randomUUID();
    this.db.transaction((tx) => {
      tx.insert(invitations).values({
        id, digest: this.credentials.digest("invitation", token), createdBy: actor.id,
        expiresAt: expiration, usesLeft: uses ?? null, adminOnly,
      }).run();
      audit(tx, actor.id, "invitation.created", id);
    }, { behavior: "immediate" });
    return { id, token, expiresAt: expiration, usesLeft: uses ?? null };
  }

  invitations(actor: Account, includeRevoked = true) {
    const query = this.db.select(invitationDetails).from(invitations)
      .where(and(invitationScope(actor), includeRevoked ? undefined : isNull(invitations.revokedAt)))
      .orderBy(desc(invitationRow.rowId));
    return includeRevoked ? query.limit(100).all() : query.all();
  }

  updateInvitation(actor: Account, id: string, changes: { expiresAt?: number | null; usesLeft?: number | null }) {
    const { expiresAt, usesLeft } = changes;
    if (expiresAt === undefined && usesLeft === undefined) fail("INVALID_REQUEST");
    if (expiresAt != null && expiresAt <= Date.now()) {
      throw new ProtocolError("INVALID_REQUEST", "Choose a future expiration date.");
    }
    return this.db.transaction((tx) => {
      const updated = tx.update(invitations).set({ expiresAt, usesLeft })
        .where(and(eq(invitations.id, id), isNull(invitations.revokedAt), invitationScope(actor)))
        .returning(invitationDetails).get();
      if (!updated) fail("NOT_FOUND");
      audit(tx, actor.id, "invitation.updated", id);
      return updated;
    }, { behavior: "immediate" });
  }

  revokeInvitation(actor: Account, id: string) {
    this.db.transaction((tx) => {
      const revoked = tx.update(invitations).set({ revokedAt: Date.now() })
        .where(and(eq(invitations.id, id), isNull(invitations.revokedAt), invitationScope(actor)))
        .returning({ id: invitations.id }).get();
      if (!revoked) fail("NOT_FOUND");
      audit(tx, actor.id, "invitation.revoked", id);
    }, { behavior: "immediate" });
  }
}
