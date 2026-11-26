INSERT INTO permissions (name) VALUES ('removeChannels');
--> statement-breakpoint
INSERT INTO role_permissions (role, permission)
SELECT role, 'removeChannels' FROM role_permissions WHERE permission = 'deleteChannels';
--> statement-breakpoint
INSERT INTO channel_overrides (channel_id, role, permission, allow)
SELECT channel_id, role, 'removeChannels', allow FROM channel_overrides WHERE permission = 'deleteChannels';
