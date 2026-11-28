/** Labels for server and channel permissions, shared by the role editor and channel settings. */
export const permissionLabels = {
  join: "See and join channels", speak: "Speak in voice", text: "Read and send channel messages", createChannels: "Create channels",
  editChannels: "Edit channels", removeChannels: "Delete channels", deleteChannels: "Delete other members’ channel messages",
  move: "Move members", mute: "Mute members",
  kick: "Kick members", ban: "Ban members", manageRoles: "Assign roles", manageInvitations: "Manage invitations",
  manageSettings: "Manage server settings", viewAdmin: "View diagnostics and audit log",
  attachFiles: "Upload attachments", sendDirectMessages: "Send direct messages", shareScreen: "Share screen",
  pinMessages: "Pin and unpin channel messages",
  useCamera: "Use camera", whisper: "Whisper to other channels",
} as const;

/** Channel-scoped permissions, grouped as they appear in channel settings. */
export const channelPermissionGroups = [
  { label: "Access and voice", permissions: ["join", "speak", "shareScreen", "useCamera", "whisper"] },
  { label: "Messaging", permissions: ["text", "attachFiles", "deleteChannels", "pinMessages"] },
  { label: "Moderation", permissions: ["mute"] },
] as const;
