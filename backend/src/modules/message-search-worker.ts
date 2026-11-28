import { Database } from "bun:sqlite";

declare const self: Worker;

type Cursor = { id: string; createdAt: number };
type Preview = Cursor & { senderId: string; text: string; attachmentName: string | null };
export type SearchPage = { messages: Preview[]; next: Cursor | null };
export type SearchQuery = { channelId: string; term: string; cutoff: number; before?: Cursor };
export type SearchJob = SearchQuery & { accountId: string; databasePath: string };
export type SearchResult = { accountId: string; page?: SearchPage };

const scanLimit = 2048;
const pageSize = 25;

function openSearch(databasePath: string) {
  const db = new Database(databasePath, { readonly: true, strict: true });
  db.run("PRAGMA busy_timeout = 250");
  const candidates = (before: boolean) => db.query<Cursor & { match: number }, Record<string, string | number>>(`
    SELECT id, created_at AS createdAt,
      CASE WHEN text LIKE $pattern ESCAPE '\\' THEN instr(lower(text), lower($term)) ELSE 0 END AS match
    FROM messages INDEXED BY messages_channel
    WHERE channel_id = $channelId AND created_at >= $cutoff
      ${before ? "AND (created_at, id) < ($createdAt, $id)" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ${scanLimit + 1}
  `);
  const first = candidates(false);
  const older = candidates(true);
  const preview = db.query<Omit<Preview, keyof Cursor>, { id: string; start: number }>(`
    SELECT sender_id AS senderId, attachments.name AS attachmentName,
      (CASE WHEN $start > 1 THEN '…' ELSE '' END) || substr(messages.text, $start, 240) ||
      (CASE WHEN length(messages.text) >= $start + 240 THEN '…' ELSE '' END) AS text
    FROM messages LEFT JOIN attachments ON attachments.message_id = messages.id
    WHERE messages.id = $id
  `);

  return db.transaction(({ channelId, term, cutoff, before }: SearchQuery): SearchPage => {
    const pattern = "%" + term.replace(/[\\%_]/g, (character) => "\\" + character) + "%";
    const rows = (before ? older : first).iterate({ channelId, term, cutoff, pattern, ...before });
    const messages: Preview[] = [];
    let scanned = 0;
    let lastScanned: Cursor | null = null;
    for (const { id, createdAt, match } of rows) {
      // Keep a continuation even when this window did not contain a match.
      if (scanned === scanLimit || (match && messages.length === pageSize)) return { messages, next: lastScanned };
      scanned++;
      lastScanned = { id, createdAt };
      if (match) messages.push({ ...lastScanned, ...preview.get({ id, start: Math.max(1, match - 60) })! });
    }
    return { messages, next: null };
  });
}

let search: ReturnType<typeof openSearch> | undefined;
self.onmessage = ({ data }: MessageEvent<SearchJob>) => {
  const { accountId, databasePath } = data;
  const result: SearchResult = { accountId };
  try {
    search ??= openSearch(databasePath);
    result.page = search(data);
  } catch (error) {
    console.error("Message search failed", error);
  }
  self.postMessage(result);
};
