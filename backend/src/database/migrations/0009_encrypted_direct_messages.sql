CREATE TABLE `direct_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`signature` text NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "direct_message_participants" CHECK("direct_messages"."sender_id" != "direct_messages"."recipient_id")
);
--> statement-breakpoint
CREATE INDEX `direct_messages_sender` ON `direct_messages` (`sender_id`,`recipient_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `direct_messages_recipient` ON `direct_messages` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `direct_messages_retention` ON `direct_messages` (`created_at`);