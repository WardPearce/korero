INSERT INTO permissions (name) VALUES ('attachFiles'), ('sendDirectMessages'), ('shareScreen'), ('useCamera'), ('whisper');
--> statement-breakpoint
WITH grants(previous, capability) AS (VALUES
  ('text', 'attachFiles'), ('text', 'sendDirectMessages'),
  ('speak', 'shareScreen'), ('speak', 'useCamera'), ('speak', 'whisper')
)
INSERT INTO role_permissions (role, permission)
SELECT role, capability FROM role_permissions JOIN grants ON permission = previous;
--> statement-breakpoint
WITH grants(previous, capability) AS (VALUES
  ('text', 'attachFiles'), ('speak', 'shareScreen'), ('speak', 'useCamera'), ('speak', 'whisper')
)
INSERT INTO channel_overrides (channel_id, role, permission, allow)
SELECT channel_id, role, capability, allow FROM channel_overrides JOIN grants ON permission = previous;
