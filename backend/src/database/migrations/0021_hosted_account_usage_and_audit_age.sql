CREATE TABLE `hosted_account_usage` (
	`id` integer PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	CONSTRAINT "hosted_account_usage_singleton" CHECK("hosted_account_usage"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX `audit_age` ON `audit` (`created_at`);
--> statement-breakpoint
-- Account for the stored payload and a fixed allowance for each account row and its index.
INSERT INTO hosted_account_usage (id, bytes)
SELECT 1, COALESCE(SUM(256 + length(CAST(encrypted_data AS BLOB))), 0) FROM hosted_accounts;
--> statement-breakpoint
CREATE TRIGGER hosted_accounts_usage_insert AFTER INSERT ON hosted_accounts BEGIN
  UPDATE hosted_account_usage
  SET bytes = bytes + 256 + length(CAST(NEW.encrypted_data AS BLOB))
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER hosted_accounts_usage_edit AFTER UPDATE OF encrypted_data ON hosted_accounts BEGIN
  UPDATE hosted_account_usage
  SET bytes = bytes + length(CAST(NEW.encrypted_data AS BLOB)) - length(CAST(OLD.encrypted_data AS BLOB))
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER hosted_accounts_usage_delete AFTER DELETE ON hosted_accounts BEGIN
  UPDATE hosted_account_usage
  SET bytes = bytes - 256 - length(CAST(OLD.encrypted_data AS BLOB))
  WHERE id = 1;
END;
