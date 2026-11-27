CREATE TABLE `profile_pictures` (
	`account_id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
