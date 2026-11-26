import Dexie, { type Table } from "dexie";
import type { TalkShortcut } from "./media/talk-shortcut";

export interface SavedServer { origin: string; name: string; passwordRequired?: boolean }
export interface DeviceIdentity { publicKey: string; privateKey: string }
export interface TrustRecord { origin: string; fingerprint: string }
type PasswordKey = [origin: string, serverId: string, channelId: string];
interface SavedPassword { origin: string; serverId: string; channelId: string; password: string }
export interface AudioPreferences {
  input: string;
  output: string;
  inputLevel: number;
  outputLevel: number;
  transmitMode: "open" | "activity" | "pushToTalk" | "toggleToTalk";
  talkShortcut: TalkShortcut;
  globalTalkShortcut: boolean;
  activityThreshold: number;
  activityHoldMs: number;
  noiseGate: boolean;
  gateThresholdDb: number;
  gateAttenuationDb: number;
  gateHoldMs: number;
  noiseSuppression: boolean;
  automaticGain: boolean;
  echoCancellation: boolean;
}

export const defaultAudio: AudioPreferences = {
  input: "", output: "", inputLevel: 100, outputLevel: 100,
  transmitMode: "open", activityThreshold: 8, activityHoldMs: 250,
  talkShortcut: { code: "KeyV", alt: true, ctrl: false, shift: false, meta: false }, globalTalkShortcut: false,
  noiseGate: false, gateThresholdDb: -45, gateAttenuationDb: 30, gateHoldMs: 150,
  noiseSuppression: true, automaticGain: true, echoCancellation: true,
};

class Preferences extends Dexie {
  declare servers: Table<SavedServer, string>;
  declare trust: Table<TrustRecord, string>;
  declare identities: Table<DeviceIdentity & { id: "default" }, "default">;
  declare local: Table<{ key: string; value: unknown }, string>;
  declare passwords: Table<SavedPassword, PasswordKey>;

  constructor() {
    super("korero-device");
    this.version(1).stores({ servers: "&origin", trust: "&origin", local: "&key" });
    this.version(2).stores({ identities: "&id" });
    this.version(3).stores({ passwords: "[origin+serverId+channelId], origin" });
  }
}

export const preferences = new Preferences();

export function getSavedPassword(origin: string, serverId: string, channelId = "") {
  return preferences.passwords.get([origin, serverId, channelId]).then((record) => record?.password);
}

export function savePassword(origin: string, serverId: string, password: string, channelId = "") {
  return preferences.passwords.put({ origin, serverId, channelId, password });
}

export function forgetPassword(origin: string, serverId: string, channelId = "", rejectedPassword?: string) {
  const records = preferences.passwords.where("[origin+serverId+channelId]").equals([origin, serverId, channelId]);
  return records.and(({ password }) => rejectedPassword === undefined || rejectedPassword === password).delete();
}

export async function getMemberVolumes(serverId: string) {
  const { value } = await preferences.local.get(`member-volumes:${serverId}`) ?? {};
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([, level]) =>
    typeof level === "number" && Number.isInteger(level) && level >= 0 && level < 100));
}

export async function saveMemberVolumes(serverId: string, value: Record<string, number>) {
  await preferences.local.put({ key: `member-volumes:${serverId}`, value });
}

export async function getUsername() {
  const stored = await preferences.local.get("username");
  return typeof stored?.value === "string" ? stored.value : "";
}

export async function saveUsername(value: string) {
  const username = value.trim();
  const length = Array.from(username).length;
  if (length < 4 || length > 32 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error("Enter a username between 4 and 32 characters.");
  }
  await preferences.local.put({ key: "username", value: username });
  return username;
}

export async function migrateSavedServers() {
  const legacy = localStorage.getItem("korero:servers");
  if (!legacy) return;
  let entries: unknown;
  try { entries = JSON.parse(legacy); } catch { return; }
  if (!Array.isArray(entries)) return;
  await preferences.transaction("rw", preferences.servers, async () => {
    for (const entry of entries) {
      if (typeof entry?.origin === "string" && typeof entry?.name === "string" &&
          !await preferences.servers.get(entry.origin)) {
        await preferences.servers.put({ name: entry.name, origin: entry.origin });
      }
    }
  });
  localStorage.removeItem("korero:servers");
}
