ALTER TABLE `messages` ADD `pinned_at` integer;--> statement-breakpoint
CREATE INDEX `messages_pins` ON `messages` (`channel_id`,`pinned_at`,`id`) WHERE "messages"."pinned_at" IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `permissions` (`name`) VALUES ('pinMessages');--> statement-breakpoint
INSERT OR IGNORE INTO `role_permissions` (`role`, `permission`)
SELECT `name`, 'pinMessages' FROM `roles` WHERE `name` IN ('Moderator', 'Administrator', 'Owner')
  AND `name` != COALESCE((SELECT `value` FROM `settings` WHERE `key` = 'defaultRole'), 'Member');
