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

export interface CapturePreferences {
  /** null shares the source's native resolution. */
  resolution: number | null;
  frameRate: number;
  videoBitrate: number;
}

export const defaultScreenCapture: CapturePreferences = { resolution: 1080, frameRate: 30, videoBitrate: 6_000_000 };
export const defaultCameraCapture: CapturePreferences = { resolution: 720, frameRate: 30, videoBitrate: 2_000_000 };

export async function getCapturePreferences(source: "screen" | "camera"): Promise<CapturePreferences> {
  const fallback = source === "camera" ? defaultCameraCapture : defaultScreenCapture;
  const { value } = await preferences.local.get(`capture:${source}`) ?? {};
  if (!value || typeof value !== "object") return fallback;
  const saved = value as Partial<CapturePreferences>;
  const resolutions = source === "camera" ? [360, 480, 720, 1080] : [360, 480, 720, 1080, 1440];
  const resolution = saved.resolution === null ? null
    : resolutions.includes(saved.resolution as number) ? saved.resolution! : fallback.resolution;
  const frameRate = [5, 15, 30, 60].includes(saved.frameRate as number) ? saved.frameRate! : fallback.frameRate;
  const minimum = source === "camera" ? 200_000 : 500_000;
  const maximum = source === "camera" ? 6_000_000 : 12_000_000;
  const videoBitrate = typeof saved.videoBitrate === "number" && Number.isFinite(saved.videoBitrate) &&
    saved.videoBitrate >= minimum && saved.videoBitrate <= maximum ? saved.videoBitrate : fallback.videoBitrate;
  return { resolution, frameRate, videoBitrate };
}

export function saveCapturePreferences(source: "screen" | "camera", value: CapturePreferences) {
  return preferences.local.put({ key: `capture:${source}`, value });
}

export const defaultMemberVolume = 100;
export const maxMemberVolume = 400;

export async function getMemberVolumes(serverId: string) {
  const { value } = await preferences.local.get(`member-volumes:${serverId}`) ?? {};
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([, level]) =>
    typeof level === "number" && Number.isInteger(level) && level >= 0 && level <= maxMemberVolume && level !== defaultMemberVolume));
}

export async function saveMemberVolumes(serverId: string, value: Record<string, number>) {
  await preferences.local.put({ key: `member-volumes:${serverId}`, value });
}
