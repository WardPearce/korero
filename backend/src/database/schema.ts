import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, blob, check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const metadata = sqliteTable("metadata", { key: text().primaryKey(), value: text().notNull() });
export const settings = sqliteTable("settings", { key: text().primaryKey(), value: text().notNull() });
export const storedMessageUsage = sqliteTable("stored_message_usage", {
  id: integer().primaryKey(), bytes: integer().notNull(),
}, (table) => [check("stored_message_usage_singleton", sql`${table.id} = 1`)]);
export const rolesTable = sqliteTable("roles", { name: text().primaryKey(), rank: integer().notNull().unique(),
  mentionable: integer({ mode: "boolean" }).notNull().default(false) });
export const permissionsTable = sqliteTable("permissions", { name: text().primaryKey() });
export const rolePermissions = sqliteTable("role_permissions", {
  role: text().notNull().references(() => rolesTable.name),
  permission: text().notNull().references(() => permissionsTable.name),
}, (table) => [primaryKey({ columns: [table.role, table.permission] })]);
export const accounts = sqliteTable("accounts", {
  id: text().primaryKey(), displayName: text("display_name").notNull(), createdAt: integer("created_at").notNull(),
  badge: text(),
});
export const profilePictures = sqliteTable("profile_pictures", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  revision: text().notNull(),
  data: blob({ mode: "buffer" }).notNull(),
});
export const hostedAccounts = sqliteTable("hosted_accounts", {
  username: text().primaryKey().notNull(),
  credentialDigest: text("credential_digest").notNull(),
  encryptedData: text("encrypted_data").notNull(),
  revision: integer().notNull(),
});
export const hostedAccountUsage = sqliteTable("hosted_account_usage", {
  id: integer().primaryKey(), bytes: integer().notNull(),
}, (table) => [check("hosted_account_usage_singleton", sql`${table.id} = 1`)]);
export const accountRoles = sqliteTable("account_roles", {
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  role: text().notNull().references(() => rolesTable.name),
}, (table) => [primaryKey({ columns: [table.accountId, table.role] }), index("account_roles_role").on(table.role)]);
export const accountIdentities = sqliteTable("account_identities", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  publicKey: text("public_key").unique().notNull(),
  origin: text().notNull(),
  joinedViaInvitation: integer("joined_via_invitation", { mode: "boolean" }).notNull().default(false),
});
export const sessions = sqliteTable("sessions", {
  id: text().primaryKey(), accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  deviceName: text("device_name").notNull(), createdAt: integer("created_at").notNull(), lastActive: integer("last_active").notNull(),
  expiresAt: integer("expires_at").notNull(), accessDigest: text("access_digest").unique().notNull(), accessExpires: integer("access_expires").notNull(),
  refreshDigest: text("refresh_digest").unique().notNull(), revokedAt: integer("revoked_at"),
}, (table) => [index("sessions_account").on(table.accountId, table.revokedAt), index("sessions_expiry").on(table.expiresAt)]);
export const refreshHistory = sqliteTable("refresh_history", {
  digest: text().primaryKey(), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  replacedAt: integer("replaced_at").notNull(), successorDigest: text("successor_digest").notNull(),
}, (table) => [index("refresh_history_session").on(table.sessionId)]);
export const invitations = sqliteTable("invitations", {
  id: text().primaryKey(), digest: text().unique().notNull(), createdBy: text("created_by").notNull().references(() => accounts.id),
  expiresAt: integer("expires_at"), usesLeft: integer("uses_left"), revokedAt: integer("revoked_at"),
  adminOnly: integer("admin_only", { mode: "boolean" }).notNull().default(false),
});
export const setup = sqliteTable("setup", {
  id: integer().primaryKey(), digest: text().notNull(), expiresAt: integer("expires_at").notNull(),
}, (table) => [check("setup_singleton", sql`${table.id} = 1`)]);
export const channels = sqliteTable("channels", {
  id: text().primaryKey(), parentId: text("parent_id").references((): AnySQLiteColumn => channels.id),
  name: text().notNull(), description: text().notNull().default(""), position: integer().notNull().default(0), capacity: integer(),
  temporary: integer({ mode: "boolean" }).notNull().default(false), passwordHash: text("password_hash"),
  backgroundImageUrl: text("background_image_url"), icon: text(),
  audioBitrate: integer("audio_bitrate"),
}, (table) => [index("channels_parent").on(table.parentId, table.position)]);
export const channelOverrides = sqliteTable("channel_overrides", {
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  role: text().notNull().references(() => rolesTable.name), permission: text().notNull().references(() => permissionsTable.name),
  allow: integer({ mode: "boolean" }).notNull(),
}, (table) => [primaryKey({ columns: [table.channelId, table.role, table.permission] }), check("override_allow", sql`${table.allow} IN (0,1)`)]);
export const bans = sqliteTable("bans", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => accounts.id), expiresAt: integer("expires_at"),
});
export const messages = sqliteTable("messages", {
  id: text().primaryKey(), channelId: text("channel_id").references(() => channels.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull().references(() => accounts.id), recipientId: text("recipient_id").references(() => accounts.id),
  text: text().notNull(), html: text(), createdAt: integer("created_at").notNull(), editedAt: integer("edited_at"), pinnedAt: integer("pinned_at"),
  // Not a foreign key: replies outlive the message they answer.
  replyToId: text("reply_to_id"),
}, (table) => [
  check("message_destination", sql`(${table.channelId} IS NULL) != (${table.recipientId} IS NULL)`),
  index("messages_channel").on(table.channelId, table.createdAt, table.id),
  index("messages_pins").on(table.channelId, table.pinnedAt, table.id).where(sql`${table.pinnedAt} IS NOT NULL`),
  index("messages_direct").on(table.senderId, table.recipientId, table.createdAt, table.id),
  index("messages_retention").on(table.createdAt),
]);
export const attachments = sqliteTable("attachments", {
  messageId: text("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  name: text().notNull(),
  size: integer().notNull(),
  data: blob({ mode: "buffer" }).notNull(),
});
export const messageReactions = sqliteTable("message_reactions", {
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  emoji: text().notNull(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.messageId, table.emoji, table.accountId] })]);
export const messageMentions = sqliteTable("message_mentions", {
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  kind: text({ enum: ["account", "role"] }).notNull(),
  target: text().notNull(),
}, (table) => [primaryKey({ columns: [table.messageId, table.kind, table.target] })]);
export const directMessages = sqliteTable("direct_messages", {
  id: text().primaryKey(),
  senderId: text("sender_id").notNull().references(() => accounts.id),
  recipientId: text("recipient_id").notNull().references(() => accounts.id),
  createdAt: integer("created_at").notNull(),
  // Set when the sender replaces the ciphertext.
  editedAt: integer("edited_at"),
  // Null until a recipient device acknowledges the packet.
  deliveredAt: integer("delivered_at"),
  nonce: text().notNull(),
  ciphertext: text().notNull(),
  signature: text().notNull(),
}, (table) => [
  check("direct_message_participants", sql`${table.senderId} != ${table.recipientId}`),
  index("direct_messages_sender").on(table.senderId, table.recipientId, table.createdAt, table.id),
  index("direct_messages_recipient").on(table.recipientId, table.createdAt),
  index("direct_messages_pending").on(table.recipientId, table.deliveredAt, table.createdAt),
  index("direct_messages_retention").on(table.createdAt),
  index("direct_messages_delivered").on(table.deliveredAt).where(sql`${table.deliveredAt} IS NOT NULL`),
]);
export const auditEvents = sqliteTable("audit", {
  id: integer().primaryKey(), actorId: text("actor_id").references(() => accounts.id), action: text().notNull(),
  targetId: text("target_id"), createdAt: integer("created_at").notNull(),
  details: text({ mode: "json" }).$type<Record<string, string | number | boolean | string[] | null>>(),
}, (table) => [index("audit_actor").on(table.actorId, table.id), index("audit_age").on(table.createdAt)]);
export const speakingRestrictions = sqliteTable("speaking_restrictions", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => accounts.id),
});
export const hearingRestrictions = sqliteTable("hearing_restrictions", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => accounts.id),
});
