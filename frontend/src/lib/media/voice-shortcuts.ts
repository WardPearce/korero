export type VoicePresence = "muted" | "deafened" | "afk";

export const voiceShortcutGroups = [
  {
    label: "Microphone",
    field: "muted",
    actions: [
      { id: "mute", label: "Mute microphone", value: true },
      { id: "unmute", label: "Unmute microphone", value: false },
      { id: "toggleMute", label: "Toggle microphone mute", value: undefined },
    ],
  },
  {
    label: "Playback",
    field: "deafened",
    actions: [
      { id: "deafen", label: "Deafen", value: true },
      { id: "undeafen", label: "Undeafen", value: false },
      { id: "toggleDeafen", label: "Toggle deafen", value: undefined },
    ],
  },
  {
    label: "Away status",
    field: "afk",
    actions: [
      { id: "goAfk", label: "Go AFK", value: true },
      { id: "returnFromAfk", label: "Return from AFK", value: false },
      { id: "toggleAfk", label: "Toggle AFK", value: undefined },
    ],
  },
] as const;

export const voiceShortcutActions = voiceShortcutGroups.flatMap(({ actions, field }) =>
  actions.map((action) => ({ ...action, field })));

export type VoiceShortcutId = (typeof voiceShortcutActions)[number]["id"];
