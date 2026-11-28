CREATE TABLE `message_mentions` (
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	PRIMARY KEY(`message_id`, `kind`, `target`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`message_id` text NOT NULL,
	`emoji` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `emoji`, `account_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to_id` text;--> statement-breakpoint
ALTER TABLE `roles` ADD `mentionable` integer DEFAULT false NOT NULL;