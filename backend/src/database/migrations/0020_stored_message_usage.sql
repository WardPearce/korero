CREATE TABLE stored_message_usage (
  id INTEGER PRIMARY KEY NOT NULL,
  bytes INTEGER NOT NULL,
  CONSTRAINT stored_message_usage_singleton CHECK (id = 1)
);
--> statement-breakpoint
-- Budget for stored payload bytes and a fixed allowance per row for metadata and indexes.
INSERT INTO stored_message_usage (id, bytes)
SELECT 1,
  COALESCE((SELECT SUM(256 + length(CAST(text AS BLOB)) + COALESCE(length(CAST(html AS BLOB)), 0)) FROM messages), 0)
  + COALESCE((SELECT SUM(256 + length(nonce) + length(ciphertext) + length(signature)) FROM direct_messages), 0);
--> statement-breakpoint
CREATE TRIGGER messages_usage_insert AFTER INSERT ON messages BEGIN
  UPDATE stored_message_usage
  SET bytes = bytes + 256 + length(CAST(NEW.text AS BLOB)) + COALESCE(length(CAST(NEW.html AS BLOB)), 0)
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER messages_usage_edit AFTER UPDATE OF text, html ON messages BEGIN
  UPDATE stored_message_usage
  SET bytes = bytes + length(CAST(NEW.text AS BLOB)) + COALESCE(length(CAST(NEW.html AS BLOB)), 0)
                   - length(CAST(OLD.text AS BLOB)) - COALESCE(length(CAST(OLD.html AS BLOB)), 0)
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER messages_usage_delete AFTER DELETE ON messages BEGIN
  UPDATE stored_message_usage
  SET bytes = bytes - 256 - length(CAST(OLD.text AS BLOB)) - COALESCE(length(CAST(OLD.html AS BLOB)), 0)
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER direct_messages_usage_insert AFTER INSERT ON direct_messages BEGIN
  UPDATE stored_message_usage
  SET bytes = bytes + 256 + length(NEW.nonce) + length(NEW.ciphertext) + length(NEW.signature)
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER direct_messages_usage_edit AFTER UPDATE OF nonce, ciphertext, signature ON direct_messages BEGIN
  UPDATE stored_message_usage
  SET bytes = bytes + length(NEW.nonce) + length(NEW.ciphertext) + length(NEW.signature)
                   - length(OLD.nonce) - length(OLD.ciphertext) - length(OLD.signature)
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER direct_messages_usage_delete AFTER DELETE ON direct_messages BEGIN
  UPDATE stored_message_usage
  SET bytes = bytes - 256 - length(OLD.nonce) - length(OLD.ciphertext) - length(OLD.signature)
  WHERE id = 1;
END;
--> statement-breakpoint
CREATE INDEX direct_messages_delivered ON direct_messages (delivered_at) WHERE delivered_at IS NOT NULL;
