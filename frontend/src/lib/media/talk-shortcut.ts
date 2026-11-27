export interface TalkShortcut {
  code: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

const supportedCode = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/;

export function shortcutFromEvent(event: KeyboardEvent): TalkShortcut | undefined {
  if (!supportedCode.test(event.code) || event.isComposing) return;
  return { code: event.code, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey };
}

export function matchesTalkShortcut(event: KeyboardEvent, shortcut: TalkShortcut) {
  const candidate = shortcutFromEvent(event);
  return Boolean(candidate && sameShortcut(candidate, shortcut));
}

export function sameShortcut(candidate: TalkShortcut, shortcut: TalkShortcut) {
  return candidate.code === shortcut.code && candidate.alt === shortcut.alt && candidate.ctrl === shortcut.ctrl &&
    candidate.shift === shortcut.shift && candidate.meta === shortcut.meta;
}

export function releasesTalkShortcut(event: KeyboardEvent, shortcut: TalkShortcut) {
  return event.code === shortcut.code || (shortcut.alt && event.key === "Alt") ||
    (shortcut.ctrl && event.key === "Control") || (shortcut.shift && event.key === "Shift") ||
    (shortcut.meta && event.key === "Meta");
}

export function talkShortcutLabel(shortcut: TalkShortcut) {
  return [shortcut.ctrl && "Ctrl", shortcut.alt && "Alt", shortcut.shift && "Shift", shortcut.meta && "Super",
    shortcut.code.replace(/^(?:Key|Digit)/, "")].filter(Boolean).join(" + ");
}

export function globalTalkShortcut(shortcut: TalkShortcut) {
  if (!shortcut.ctrl && !shortcut.alt && !shortcut.meta && !shortcut.code.startsWith("F")) return null;
  return [shortcut.ctrl && "Control", shortcut.alt && "Alt", shortcut.shift && "Shift", shortcut.meta && "Super",
    shortcut.code].filter(Boolean).join("+");
}

export function isTypingTalkShortcut(event: KeyboardEvent, shortcut: TalkShortcut) {
  return !shortcut.alt && !shortcut.ctrl && !shortcut.meta && !shortcut.code.startsWith("F") &&
    event.target instanceof Element && Boolean(event.target.closest("input, textarea, select, [contenteditable='true']"));
}
