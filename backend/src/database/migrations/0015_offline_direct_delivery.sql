ALTER TABLE `direct_messages` ADD `delivered_at` integer;--> statement-breakpoint
CREATE INDEX `direct_messages_pending` ON `direct_messages` (`recipient_id`,`delivered_at`,`created_at`);--> statement-breakpoint
UPDATE `direct_messages` SET `delivered_at` = `created_at`;