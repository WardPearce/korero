import { createContext } from "svelte";
import { messageFrom } from "../connection/client";
import { preferences } from "../preferences";
import type { AudioSettings } from "./audio.svelte";
import { matchesTalkShortcut, sameShortcut, type TalkShortcut } from "./talk-shortcut";
import { voiceShortcutActions, type VoiceShortcutId } from "./voice-shortcuts";

type VoiceBindings = Partial<Record<VoiceShortcutId, TalkShortcut>>;
type WhisperSettings = { mode: "hold" | "toggle"; shortcut: TalkShortcut };
const defaultWhisper: WhisperSettings = {
  mode: "hold",
  shortcut: { code: "KeyB", alt: true, shift: false, ctrl: false, meta: false },
};

export class ShortcutSettings {
  voice = $state.raw<VoiceBindings>({});
  whisper = $state.raw(defaultWhisper);
  ready = $state(false);
  saving = $state(false);
  error = $state("");

  constructor(readonly audio: AudioSettings) {}

  async load() {
    try {
      const [voice, whisper] = await preferences.local.bulkGet(["voice-shortcuts", "whisper"]);
      this.voice = (voice?.value as VoiceBindings | undefined) ?? {};
      this.whisper = { ...defaultWhisper, ...(whisper?.value as Partial<WhisperSettings> | undefined) };
      await this.audio.load();
      this.ready = true;
    } catch (error) {
      this.error = messageFrom(error);
    }
  }

  private conflict(id: VoiceShortcutId | "talk" | "whisper", shortcut: TalkShortcut) {
    if (this.audio.available) {
      if (id !== "talk" && sameShortcut(shortcut, this.audio.profile.talkShortcut)) return "Talk shortcut";
      if (id !== "whisper" && sameShortcut(shortcut, this.whisper.shortcut)) return "Whisper shortcut";
    }
    return voiceShortcutActions.find((action) => {
      const binding = this.voice[action.id];
      return action.id !== id && binding && sameShortcut(shortcut, binding);
    })?.label;
  }

  private async save(work: () => Promise<void>, id?: VoiceShortcutId | "talk" | "whisper", shortcut?: TalkShortcut) {
    if (!this.ready || this.saving) return;
    this.error = "";
    const conflict = id && shortcut && this.conflict(id, shortcut);
    if (conflict) {
      this.error = `That shortcut is already assigned to ${conflict}.`;
      return;
    }
    this.saving = true;
    try {
      await work();
    } catch (error) {
      this.error = messageFrom(error);
    } finally {
      this.saving = false;
    }
  }

  setVoice(id: VoiceShortcutId, shortcut?: TalkShortcut) {
    return this.save(async () => {
      const next = { ...this.voice };
      if (shortcut) next[id] = shortcut;
      else delete next[id];
      await preferences.local.put({ key: "voice-shortcuts", value: next });
      this.voice = next;
    }, id, shortcut);
  }

  setTalk(shortcut: TalkShortcut) {
    if (!this.audio.available || this.audio.applying) return;
    return this.save(async () => {
      await this.audio.update("talkShortcut", shortcut);
      this.error = this.audio.error;
    }, "talk", shortcut);
  }

  setWhisper(update: Partial<WhisperSettings>) {
    return this.save(async () => {
      const next = { ...this.whisper, ...update };
      await preferences.local.put({ key: "whisper", value: next });
      this.whisper = next;
    }, "whisper", update.shortcut);
  }

  matchVoiceAction(event: KeyboardEvent) {
    if (!this.ready || event.defaultPrevented || event.repeat) return;
    if (event.target instanceof HTMLElement && (
      event.target.isContentEditable || event.target.closest("input, textarea, select, [role='textbox']") ||
      (event.code === "Space" && event.target.closest("button, a[href], [role='button'], [role='menuitem']"))
    )) return;
    return voiceShortcutActions.find(({ id }) => {
      const binding = this.voice[id];
      return binding && matchesTalkShortcut(event, binding);
    });
  }
}

export const [getShortcutSettings, setShortcutSettings] = createContext<ShortcutSettings>();
