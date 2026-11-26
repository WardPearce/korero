ALTER TABLE `audit` ADD `details` text;--> statement-breakpoint
CREATE INDEX `audit_actor` ON `audit` (`actor_id`,`id`);