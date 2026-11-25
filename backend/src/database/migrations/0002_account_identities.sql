CREATE TABLE `account_identities` (
	`account_id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`origin` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_identities_public_key_unique` ON `account_identities` (`public_key`);