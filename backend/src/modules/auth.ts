import { and, count, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lte, ne, or, type SQL } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import { audit, type Queries, type Role, type Store } from "../database";
import { accounts, accountRoles, bans, invitations, recoveryCredentials, refreshHistory, sessions, setup } from "../database/schema";
import { Credentials, equalDigest, normalizeRecovery, randomToken, recoveryCode } from "../security/credentials";
import { fail } from "../security/errors";

export type Account = { id: string; displayName: string; role: Role; createdAt: number };
const { accessDigest: _, ...sessionColumns } = getTableColumns(sessions);
export type Session = Omit<typeof sessions.$inferSelect, "accessDigest">;
type Ticket = { sessionId: string; expiresAt: number };
type RevokedSession = { id: string };

const invitationRow = sqliteTable("invitations", { rowId: integer("rowid") });

function getAccount(db: Queries, id: string): Account {
  const row = db.select({ id: accounts.id, displayName: accounts.displayName, createdAt: accounts.createdAt, role: accountRoles.role })
    .from(accounts).innerJoin(accountRoles, eq(accounts.id, accountRoles.accountId)).where(eq(accounts.id, id)).get();
  if (!row) fail("NOT_FOUND");
  return { ...row, role: row.role as Role };
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
  private readonly tickets = new Map<string, Ticket>();
  onRevoked: (sessionIds: Set<string>) => void = () => {};
  onAccountChanged: (accountId: string) => void = () => {};
  constructor(private readonly db: Store, private readonly credentials: Credentials, private readonly config: Config) {}

  account(id: string) { return getAccount(this.db, id); }
  updateAccount(id: string, displayName: string) {
    this.db.update(accounts).set({ displayName }).where(eq(accounts.id, id)).run();
    this.onAccountChanged(id);
    return this.account(id);
  }
  hasOwner() { return hasOwner(this.db); }

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

  bootstrap(token: string, name: string, device: string) {
    return this.db.transaction((tx) => {
      if (hasOwner(tx)) fail("NOT_FOUND");
      const row = tx.select().from(setup).where(eq(setup.id, 1)).get();
      if (!row || row.expiresAt <= Date.now() || !equalDigest(row.digest, this.credentials.digest("setup", token))) fail("AUTH_FAILED");
      tx.delete(setup).where(eq(setup.id, row.id)).run();
      const result = this.createAccount(tx, name, device, "Owner");
      audit(tx, result.account.id, "setup.consumed", result.account.id);
      return result;
    }, { behavior: "immediate" });
  }

  register(name: string, device: string, invitation?: string) {
    return this.db.transaction((tx) => {
      const mode = this.config.server.registration;
      if (mode === "disabled") fail("FORBIDDEN");
      if (mode !== "open" || invitation) {
        if (!invitation) fail("AUTH_FAILED");
        const row = tx.select({ id: invitations.id, usesLeft: invitations.usesLeft }).from(invitations).where(and(
          eq(invitations.digest, this.credentials.digest("invitation", invitation)),
          isNull(invitations.revokedAt),
          or(isNull(invitations.expiresAt), gt(invitations.expiresAt, Date.now())),
          or(isNull(invitations.usesLeft), gt(invitations.usesLeft, 0)),
          mode === "admin" ? eq(invitations.adminOnly, true) : undefined,
        )).get();
        if (!row) fail("AUTH_FAILED");
        if (row.usesLeft !== null) tx.update(invitations).set({ usesLeft: row.usesLeft - 1 }).where(eq(invitations.id, row.id)).run();
      }
      return this.createAccount(tx, name, device, "Member");
    }, { behavior: "immediate" });
  }

  private createAccount(db: Queries, name: string, device: string, role: Role) {
    const id = randomUUID();
    const createdAt = Date.now();
    db.insert(accounts).values({ id, displayName: name, createdAt }).run();
    db.insert(accountRoles).values({ accountId: id, role }).run();
    const recovery = recoveryCode();
    db.insert(recoveryCredentials).values({ accountId: id, digest: this.credentials.digest("recovery", normalizeRecovery(recovery)!) }).run();
    return { account: { id, displayName: name, role, createdAt }, recoveryCode: recovery, ...this.createSession(db, id, device) };
  }

  recover(code: string, device: string) {
    return this.db.transaction((tx) => {
      const normal = normalizeRecovery(code);
      if (!normal) fail("AUTH_FAILED");
      const row = tx.select({ accountId: recoveryCredentials.accountId }).from(recoveryCredentials)
        .where(eq(recoveryCredentials.digest, this.credentials.digest("recovery", normal))).get();
      if (!row || isBanned(tx, row.accountId)) fail("AUTH_FAILED");
      return { account: getAccount(tx, row.accountId), ...this.createSession(tx, row.accountId, device) };
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

  rotateRecovery(session: Session, oldCode: string, revokeOthers: boolean) {
    const { code, revoked } = this.db.transaction((tx) => {
      const row = tx.select({ digest: recoveryCredentials.digest }).from(recoveryCredentials)
        .where(eq(recoveryCredentials.accountId, session.accountId)).get();
      const normal = normalizeRecovery(oldCode);
      if (!row || !normal || !equalDigest(row.digest, this.credentials.digest("recovery", normal))) fail("AUTH_FAILED");
      const code = recoveryCode();
      tx.update(recoveryCredentials).set({ digest: this.credentials.digest("recovery", normalizeRecovery(code)!) })
        .where(eq(recoveryCredentials.accountId, session.accountId)).run();
      audit(tx, session.accountId, "recovery.rotated", session.accountId);
      const revoked = revokeOthers ? this.markRevoked(tx, eq(sessions.accountId, session.accountId), ne(sessions.id, session.id)) : [];
      return { code, revoked };
    }, { behavior: "immediate" });
    this.notifyRevoked(revoked);
    return { recoveryCode: code };
  }

  refresh(token: string) {
    const result = this.db.transaction((tx) => {
      const now = Date.now();
      const old = this.credentials.digest("refresh", token);
      const session = findSession(tx, eq(sessions.refreshDigest, old), now);
      const credentials = {
        accessToken: this.credentials.successor("access", token),
        refreshToken: this.credentials.successor("refresh", token),
      };
      if (session) {
        if (isBanned(tx, session.accountId)) fail("AUTH_FAILED");
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
      const previous = tx.select().from(refreshHistory).where(eq(refreshHistory.digest, old)).get();
      if (!previous) fail("AUTH_FAILED");
      const active = findSession(tx, eq(sessions.id, previous.sessionId), now);
      if (!active || isBanned(tx, active.accountId)) fail("AUTH_FAILED");
      if (now - previous.replacedAt <= this.config.authentication.refresh_retry_seconds * 1000) {
        if (!equalDigest(active.refreshDigest, previous.successorDigest)) fail("REFRESH_RETRY");
        return { ok: true as const, credentials: {
          sessionId: active.id, ...credentials, accessExpiresAt: active.accessExpires, refreshExpiresAt: active.expiresAt,
        } };
      }
      const revoked = this.markRevoked(tx, eq(sessions.id, active.id));
      audit(tx, active.accountId, "session.reuse_detected", active.id);
      return { ok: false as const, revoked };
    }, { behavior: "immediate" });
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
    for (const [digest, ticket] of this.tickets) if (ids.has(ticket.sessionId)) this.tickets.delete(digest);
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
    for (const [digest, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(digest);
    if (persistent) {
      const expired = this.db.select({ id: sessions.id }).from(sessions)
        .where(or(lte(sessions.expiresAt, now), isNotNull(sessions.revokedAt))).limit(1000);
      this.db.delete(sessions).where(inArray(sessions.id, expired)).run();
    }
  }

  ticket(session: Session) {
    this.sweep(Date.now(), false);
    if (this.tickets.size >= Math.max(64, this.config.server.max_users * 8)) fail("LIMIT");
    const ticket = randomToken();
    const expiresAt = Date.now() + this.config.authentication.ticket_seconds * 1000;
    this.tickets.set(this.credentials.digest("ticket", ticket), { sessionId: session.id, expiresAt });
    return { ticket, expiresAt };
  }

  consumeTicket(token: string) {
    const digest = this.credentials.digest("ticket", token);
    const ticket = this.tickets.get(digest);
    this.tickets.delete(digest);
    if (!ticket || ticket.expiresAt <= Date.now()) fail("AUTH_FAILED");
    const session = this.getSession(ticket.sessionId);
    if (!session || isBanned(this.db, session.accountId)) fail("AUTH_FAILED");
    return session;
  }

  invitation(actor: Account, expiresInSeconds?: number, uses?: number) {
    const adminOnly = actor.role === "Administrator" || actor.role === "Owner";
    if (this.config.server.registration === "admin" && !adminOnly) fail("FORBIDDEN");
    const token = randomToken();
    const id = randomUUID();
    const expiresAt = expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : null;
    this.db.transaction((tx) => {
      tx.insert(invitations).values({
        id, digest: this.credentials.digest("invitation", token), createdBy: actor.id,
        expiresAt, usesLeft: uses ?? null, adminOnly,
      }).run();
      audit(tx, actor.id, "invitation.created", id);
    }, { behavior: "immediate" });
    return { id, token, expiresAt, usesLeft: uses ?? null };
  }

  invitations(actor: Account) {
    const { id, createdBy, expiresAt, usesLeft, revokedAt } = invitations;
    return this.db.select({ id, createdBy, expiresAt, usesLeft, revokedAt }).from(invitations)
      .where(actor.role === "Moderator" ? eq(createdBy, actor.id) : undefined)
      .orderBy(desc(invitationRow.rowId)).limit(100).all();
  }

  revokeInvitation(actor: Account, id: string) {
    this.db.transaction((tx) => {
      const revoked = tx.update(invitations).set({ revokedAt: Date.now() })
        .where(and(eq(invitations.id, id), isNull(invitations.revokedAt),
          actor.role === "Moderator" ? eq(invitations.createdBy, actor.id) : undefined)).returning({ id: invitations.id }).get();
      if (!revoked) fail("NOT_FOUND");
      audit(tx, actor.id, "invitation.revoked", id);
    }, { behavior: "immediate" });
  }
}
