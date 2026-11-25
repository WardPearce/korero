import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { existsSync } from "node:fs";
import * as schema from "./schema";

export const LOBBY = "00000000-0000-4000-8000-000000000001";
export const roles = ["Guest", "Member", "Moderator", "Administrator", "Owner"] as const;
export type Role = string;
export const permissions = ["join", "speak", "text", "createChannels", "editChannels", "deleteChannels", "move", "mute", "kick",
  "ban", "manageRoles", "manageInvitations", "manageSettings", "viewAdmin"] as const;
export type Permission = typeof permissions[number];
export const channelPermissions = ["join", "speak", "text", "createChannels", "editChannels", "deleteChannels", "move", "mute"] as const;
const defaultPermissions: Record<typeof roles[number], readonly Permission[]> = {
  Guest: ["join"], Member: ["join", "speak", "text"], Moderator: ["join", "speak", "text", "move", "mute", "kick", "manageInvitations"],
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
        tx.insert(schema.permissionsTable).values(permissions.map((name) => ({ name }))).run();
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

export function audit(db: Queries, actorId: string | null, action: string, targetId: string | null) {
  db.insert(schema.auditEvents).values({ actorId, action, targetId, createdAt: Date.now() }).run();
}
