-- Keep inherited denials that protect existing channels as these grants become server-wide.
DELETE FROM channel_overrides
WHERE permission IN ('createChannels', 'editChannels', 'removeChannels', 'move') AND allow = 1;
