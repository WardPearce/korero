import Dexie, { type Table } from "dexie";

export interface SavedServer { origin: string; name: string }
export interface DeviceIdentity { publicKey: string; privateKey: string }
export interface TrustRecord { origin: string; fingerprint: string }
export interface AudioPreferences {
  input: string;
  output: string;
  inputLevel: number;
  outputLevel: number;
  transmitMode: "open" | "activity" | "pushToTalk";
  activityThreshold: number;
  noiseSuppression: boolean;
  automaticGain: boolean;
  echoCancellation: boolean;
}

export const defaultAudio: AudioPreferences = {
  input: "", output: "", inputLevel: 100, outputLevel: 100,
  transmitMode: "open", activityThreshold: 8,
  noiseSuppression: true, automaticGain: true, echoCancellation: true,
};

class Preferences extends Dexie {
  declare servers: Table<SavedServer, string>;
  declare trust: Table<TrustRecord, string>;
  declare identities: Table<DeviceIdentity & { id: "default" }, "default">;
  declare local: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super("korero-device");
    this.version(1).stores({ servers: "&origin", trust: "&origin", local: "&key" });
    this.version(2).stores({ identities: "&id" });
  }
}

export const preferences = new Preferences();

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
