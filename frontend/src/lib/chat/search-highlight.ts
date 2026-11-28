/** Splits `text` into runs so every case-insensitive occurrence of `query` can be highlighted. */
export function matchParts(text: string, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLocaleLowerCase();
  // Lowercasing can change string length in a few scripts. Highlighting would then misalign.
  if (haystack.length !== text.length) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let position = 0;
  for (let found = haystack.indexOf(needle); found >= 0; found = haystack.indexOf(needle, position)) {
    if (found > position) parts.push({ text: text.slice(position, found), match: false });
    parts.push({ text: text.slice(found, found + needle.length), match: true });
    position = found + needle.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position), match: false });
  return parts;
}
