import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(localizedFormat);
dayjs.extend(relativeTime);

/** Display styles for `<t:unix:style>` tokens, matching the widely used chat timestamp syntax. */
export const timestampStyles = [
  { style: "t", label: "Short time", format: "LT" },
  { style: "T", label: "Long time", format: "LTS" },
  { style: "d", label: "Short date", format: "L" },
  { style: "D", label: "Long date", format: "LL" },
  { style: "f", label: "Short date and time", format: "LLL" },
  { style: "F", label: "Long date and time", format: "dddd, LLL" },
  { style: "R", label: "Relative", format: undefined },
] as const;

export type TimestampStyle = (typeof timestampStyles)[number]["style"];

const defaultStyle: TimestampStyle = "f";
// Seconds since the epoch, bounded to ±8.64e12 s so the value stays a valid JS date.
const tokenSource = String.raw`<t:(-?\d{1,13})(?::([tTdDfFR]))?>`;
const maxSeconds = 8.64e12;

export function timestampToken(unixSeconds: number, style: TimestampStyle = defaultStyle) {
  const seconds = Math.trunc(unixSeconds);
  return style === defaultStyle ? `<t:${seconds}>` : `<t:${seconds}:${style}>`;
}

export function formatTimestamp(unixSeconds: number, style: TimestampStyle = defaultStyle, now = Date.now()) {
  const time = dayjs.unix(unixSeconds);
  if (style === "R") return time.from(now);
  return time.format(timestampStyles.find((entry) => entry.style === style)?.format);
}

/** Full local date, time and zone, used as the hover title of rendered timestamps. */
export function describeTimestamp(unixSeconds: number) {
  return `${dayjs.unix(unixSeconds).format("dddd, LL LTS")} (${localTimeZone()})`;
}

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || dayjs().format("Z");
}

export function hasTimestamps(text: string) {
  return new RegExp(tokenSource).test(text);
}

/** Splits text into literal strings and timestamp tokens. */
export function parseTimestamps(text: string) {
  const parts: (string | { seconds: number; style: TimestampStyle })[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(tokenSource, "g"))) {
    const seconds = Number(match[1]);
    if (Math.abs(seconds) > maxSeconds) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ seconds, style: (match[2] ?? defaultStyle) as TimestampStyle });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Replaces timestamp tokens in text nodes, outside code, with `<time>` elements in the viewer's time zone. */
export function renderTimestamps(root: ParentNode) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("code, pre") && hasTimestamps(node.data)) nodes.push(node);
  }
  for (const node of nodes) {
    const replacement = document.createDocumentFragment();
    for (const part of parseTimestamps(node.data)) {
      if (typeof part === "string") {
        replacement.append(part);
        continue;
      }
      const time = document.createElement("time");
      time.className = "chat-timestamp";
      time.dateTime = dayjs.unix(part.seconds).toISOString();
      time.dataset.seconds = String(part.seconds);
      time.dataset.style = part.style;
      time.title = describeTimestamp(part.seconds);
      time.textContent = formatTimestamp(part.seconds, part.style);
      replacement.append(time);
    }
    node.replaceWith(replacement);
  }
}

/** Keeps relative timestamps under `root` current. Returns a cleanup function. */
export function refreshRelativeTimestamps(root: HTMLElement) {
  const update = () => {
    for (const time of root.querySelectorAll<HTMLTimeElement>("time.chat-timestamp[data-style='R']")) {
      time.textContent = formatTimestamp(Number(time.dataset.seconds), "R");
    }
  };
  if (!root.querySelector("time.chat-timestamp[data-style='R']")) return () => {};
  const timer = setInterval(update, 30_000);
  return () => clearInterval(timer);
}
