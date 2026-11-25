CREATE TABLE `account_roles` (
	`account_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role`) REFERENCES `roles`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_roles_role` ON `account_roles` (`role`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit` (
	`id` integer PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bans` (
	`account_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `channel_overrides` (
	`channel_id` text NOT NULL,
	`role` text NOT NULL,
	`permission` text NOT NULL,
	`allow` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `role`, `permission`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role`) REFERENCES `roles`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`permission`) REFERENCES `permissions`(`name`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "override_allow" CHECK("channel_overrides"."allow" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`capacity` integer,
	`temporary` integer DEFAULT false NOT NULL,
	`password_hash` text,
	FOREIGN KEY (`parent_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `channels_parent` ON `channels` (`parent_id`,`position`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer,
	`uses_left` integer,
	`revoked_at` integer,
	`admin_only` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_digest_unique` ON `invitations` (`digest`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text,
	`sender_id` text NOT NULL,
	`recipient_id` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_destination" CHECK(("messages"."channel_id" IS NULL) != ("messages"."recipient_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `messages_channel` ON `messages` (`channel_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `messages_direct` ON `messages` (`sender_id`,`recipient_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `messages_retention` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`name` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recovery_credentials` (
	`account_id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_credentials_digest_unique` ON `recovery_credentials` (`digest`);--> statement-breakpoint
CREATE TABLE `refresh_history` (
	`digest` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`replaced_at` integer NOT NULL,
	`successor_digest` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `refresh_history_session` ON `refresh_history` (`session_id`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role` text NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`role`, `permission`),
	FOREIGN KEY (`role`) REFERENCES `roles`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`permission`) REFERENCES `permissions`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`name` text PRIMARY KEY NOT NULL,
	`rank` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_rank_unique` ON `roles` (`rank`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`device_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_active` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`access_digest` text NOT NULL,
	`access_expires` integer NOT NULL,
	`refresh_digest` text NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_access_digest_unique` ON `sessions` (`access_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_refresh_digest_unique` ON `sessions` (`refresh_digest`);--> statement-breakpoint
CREATE INDEX `sessions_account` ON `sessions` (`account_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `setup` (
	`id` integer PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "setup_singleton" CHECK("setup"."id" = 1)
);
