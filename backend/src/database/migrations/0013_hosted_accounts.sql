CREATE TABLE `hosted_accounts` (
	`username` text PRIMARY KEY NOT NULL,
	`credential_digest` text NOT NULL,
	`encrypted_data` text NOT NULL,
	`revision` integer NOT NULL
);
