import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { existsSync } from "node:fs";
import * as schema from "./schema";

export const LOBBY = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_ROLE_KEY = "defaultRole";
export const INITIAL_ROLE = "Member";
export const roles = ["Guest", "Member", "Moderator", "Administrator", "Owner"] as const;
export const editableBuiltInRoles = ["Guest", "Member", "Moderator"] as const;
export type Role = string;
/** Every account holds at least one of these. */
export const baseRoles = ["Guest", "Member"] as const;
export const MAX_ACCOUNT_ROLES = 25;
export function isBaseRole(role: Role) { return (baseRoles as readonly string[]).includes(role); }
/** Built-in roles rank by position. Custom roles (negative database ranks) share a tier between Moderator and Administrator. */
export function roleRank(name: Role, dbRank: number) {
  if (dbRank < 0) return 2.5;
  const rank = roles.findIndex((role) => role === name);
  return rank < 0 ? dbRank : rank;
}
/** Highest rank first. Among custom roles the earliest created (database rank closest to zero) comes first. */
export function sortRoles(rows: readonly { name: Role; rank: number }[]) {
  return [...rows].sort((a, b) => roleRank(b.name, b.rank) - roleRank(a.name, a.rank) || b.rank - a.rank).map(({ name }) => name);
}
export const permissions = ["join", "speak", "text", "createChannels", "editChannels", "deleteChannels", "move", "mute", "kick",
  "ban", "manageRoles", "manageInvitations", "manageSettings", "viewAdmin", "attachFiles", "sendDirectMessages",
  "shareScreen", "useCamera", "whisper", "removeChannels", "pinMessages"] as const;
export type Permission = typeof permissions[number];
export const channelPermissions = ["join", "speak", "text", "deleteChannels", "mute",
  "attachFiles", "shareScreen", "useCamera", "whisper", "pinMessages"] as const;
export const inheritedChannelPermissions = [...channelPermissions, "createChannels", "editChannels", "removeChannels", "move"] as const;
export const memberPermissions = ["join", "speak", "text", "attachFiles", "sendDirectMessages", "shareScreen", "useCamera", "whisper"] as const;
export const defaultPermissions: Record<typeof roles[number], readonly Permission[]> = {
  Guest: ["join"], Member: memberPermissions, Moderator: [...memberPermissions, "move", "mute", "kick", "manageInvitations", "pinMessages"],
  Administrator: permissions, Owner: permissions,
};

const sqliteCatalog = sqliteTable("sqlite_master", { type: text().notNull(), name: text().notNull() });
export const migrationHistory = sqliteTable("__drizzle_migrations", {
  hash: text().notNull(),
  createdAt: integer("created_at").notNull(),
});

export function lockDirectory(directory: string) {
  const client = new Database(join(directory, "instance.lock.sqlite"));
  const lock = drizzle(client);
  try {
    // Retain SQLite's exclusive file lock until the server or maintenance command exits.
    lock.run(sql`PRAGMA busy_timeout = 0`);
    lock.run(sql`BEGIN EXCLUSIVE`);
  } catch {
    client.close();
    throw new Error("The data directory is already in use by another server or CLI command");
  }
  return () => client.close();
}

export function openDatabase(directory: string) {
  const client = new Database(join(directory, "server.db"), { strict: true });
  try {
    const db = drizzle(client, { schema });
    db.run(sql`PRAGMA foreign_keys = ON`);
    db.run(sql`PRAGMA journal_mode = WAL`);
    db.run(sql`PRAGMA busy_timeout = 3000`);
    db.run(sql`PRAGMA secure_delete = ON`);
    const embedded = "/$bunfs/root/migrations";
    const config = { migrationsFolder: existsSync(embedded) ? embedded : join(import.meta.dir, "migrations") };
    const expected = readMigrationFiles(config);
    if (db.select({ name: sqliteCatalog.name }).from(sqliteCatalog)
      .where(and(eq(sqliteCatalog.type, "table"), eq(sqliteCatalog.name, "__drizzle_migrations"))).get()) {
      const applied = db.select().from(migrationHistory).orderBy(migrationHistory.createdAt).all();
      if (applied.some((row, index) => expected[index]?.hash !== row.hash || expected[index]?.folderMillis !== row.createdAt)) {
        throw new Error("Database migration history differs from this server build");
      }
    }
    migrate(db, config);
    db.transaction((tx) => {
      if (!tx.select().from(schema.metadata).limit(1).get()) {
        tx.insert(schema.metadata).values({ key: "serverId", value: randomUUID() }).run();
        tx.insert(schema.channels).values({ id: LOBBY, name: "Lobby" }).run();
        tx.insert(schema.permissionsTable).values(permissions.map((name) => ({ name })))
          .onConflictDoNothing({ target: schema.permissionsTable.name }).run();
        tx.insert(schema.rolesTable).values(roles.map((name, rank) => ({ name, rank }))).run();
        tx.insert(schema.rolePermissions).values(roles.flatMap((role) =>
          defaultPermissions[role].map((permission) => ({ role, permission })))).run();
      }
    }, { behavior: "immediate" });
    return db;
  } catch (error) { client.close(); throw error; }
}

export type Store = ReturnType<typeof openDatabase>;

export type Queries = Pick<Store, "select" | "insert" | "update" | "delete">;

export function snapshotDatabase(db: Store, destination: string) {
  // The ORM has no backup builder. SQLite snapshots committed WAL contents directly to disk.
  db.run(sql`VACUUM INTO ${destination}`);
}

export function audit(db: Queries, actorId: string | null, action: string, targetId: string | null,
  details?: NonNullable<typeof schema.auditEvents.$inferInsert.details>) {
  db.insert(schema.auditEvents).values({ actorId, action, targetId, details, createdAt: Date.now() }).run();
}

export function limitAuditInserts(db: Store, maxEvents: number) {
  // A TEMP trigger uses this server's configured limit and does not persist in backups.
  // Trim one row on each insert to keep up with writes between cleanup batches.
  db.run(sql`CREATE TEMP TRIGGER trim_audit_overflow AFTER INSERT ON main.audit BEGIN
    DELETE FROM audit WHERE id = NEW.id - ${sql.raw(Number(maxEvents).toString())};
  END`);
}

export function pruneAudit(db: Store, cutoff: number, maxEvents: number) {
  const { id, createdAt } = schema.auditEvents;
  const expired = db.select({ id }).from(schema.auditEvents).where(lt(createdAt, cutoff)).orderBy(createdAt).limit(1000);
  db.delete(schema.auditEvents).where(inArray(id, expired)).run();

  const overflow = db.select({ id }).from(schema.auditEvents)
    .where(lte(id, sql`(SELECT max(id) FROM audit) - ${maxEvents}`)).orderBy(id).limit(1000);
  db.delete(schema.auditEvents).where(inArray(id, overflow)).run();
}
