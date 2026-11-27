ALTER TABLE `account_identities` ADD `joined_via_invitation` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `account_identities`
SET `joined_via_invitation` = 1
WHERE EXISTS (
  SELECT 1 FROM `audit`
  WHERE `audit`.`actor_id` = `account_identities`.`account_id`
    AND `audit`.`target_id` = `account_identities`.`account_id`
    AND `audit`.`action` = 'account.registered'
    AND CASE WHEN json_valid(`audit`.`details`) THEN json_type(`audit`.`details`, '$.invitationId') END = 'text'
);
