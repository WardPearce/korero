PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_roles` (
	`account_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`account_id`, `role`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role`) REFERENCES `roles`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_account_roles`("account_id", "role") SELECT "account_id", "role" FROM `account_roles`;--> statement-breakpoint
DROP TABLE `account_roles`;--> statement-breakpoint
ALTER TABLE `__new_account_roles` RENAME TO `account_roles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `account_roles_role` ON `account_roles` (`role`);--> statement-breakpoint
-- Every account keeps a base role. Accounts that only held a higher role also become Members.
INSERT INTO `account_roles` (`account_id`, `role`)
SELECT `id`, 'Member' FROM `accounts` WHERE NOT EXISTS (
  SELECT 1 FROM `account_roles` WHERE `account_roles`.`account_id` = `accounts`.`id` AND `account_roles`.`role` IN ('Guest', 'Member'));
--> statement-breakpoint
-- Channel overrides now combine across held roles, so a Member deny would also reach the higher roles
-- that were just given Member. Write an explicit allow wherever such a role was allowed before.
WITH RECURSIVE `ancestors` (`channel_id`, `ancestor_id`, `depth`) AS (
  SELECT `id`, `parent_id`, 1 FROM `channels` WHERE `parent_id` IS NOT NULL
  UNION ALL
  SELECT `ancestors`.`channel_id`, `channels`.`parent_id`, `ancestors`.`depth` + 1
  FROM `ancestors` JOIN `channels` ON `channels`.`id` = `ancestors`.`ancestor_id` WHERE `channels`.`parent_id` IS NOT NULL
), `candidates` (`channel_id`, `role`, `permission`) AS (
  SELECT `denied`.`channel_id`, `roles`.`name`, `denied`.`permission`
  FROM `channel_overrides` AS `denied` JOIN `roles` ON `roles`.`name` NOT IN ('Guest', 'Member', 'Owner')
  WHERE `denied`.`role` = 'Member' AND `denied`.`allow` = 0 AND NOT EXISTS (
    SELECT 1 FROM `channel_overrides` AS `own` WHERE `own`.`channel_id` = `denied`.`channel_id`
      AND `own`.`role` = `roles`.`name` AND `own`.`permission` = `denied`.`permission`)
)
INSERT INTO `channel_overrides` (`channel_id`, `role`, `permission`, `allow`)
SELECT `channel_id`, `role`, `permission`, 1 FROM `candidates` WHERE COALESCE(
  (SELECT `inherited`.`allow` FROM `ancestors` JOIN `channel_overrides` AS `inherited` ON `inherited`.`channel_id` = `ancestors`.`ancestor_id`
    WHERE `ancestors`.`channel_id` = `candidates`.`channel_id` AND `inherited`.`role` = `candidates`.`role`
      AND `inherited`.`permission` = `candidates`.`permission` ORDER BY `ancestors`.`depth` LIMIT 1),
  EXISTS (SELECT 1 FROM `role_permissions` WHERE `role_permissions`.`role` = `candidates`.`role`
    AND `role_permissions`.`permission` = `candidates`.`permission`)) = 1;
