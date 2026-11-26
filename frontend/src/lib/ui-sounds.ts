import * as Tone from "tone";

type Sound = "channel" | "connect" | "disconnect" | "mute" | "unmute" | "deafen" | "undeafen" | "message" | "afk" | "back";

const notes: Record<Sound, [number, number, number]> = {
  channel: [520, 660, 0.12],
  connect: [440, 660, 0.2],
  disconnect: [660, 440, 0.2],
  mute: [520, 390, 0.12],
  unmute: [390, 520, 0.12],
  deafen: [440, 330, 0.14],
  undeafen: [330, 440, 0.14],
  message: [740, 880, 0.1],
  afk: [660, 520, 0.2],
  back: [520, 660, 0.2],
};

let synth: Tone.Synth | undefined;
let filter: Tone.Filter | undefined;
let reverb: Tone.Reverb | undefined;
let gain: Tone.Gain | undefined;
let audioReady: Promise<void> | undefined;

/** Plays a short synthesized UI cue; Tone's audio context starts on the user's gesture. */
export function playUiSound(sound: Sound) {
  try {
    audioReady ??= Tone.start().then(() => {
      // A muffled, low level signal with a little room reflection feels further away.
      gain = new Tone.Gain(0.42).toDestination();
      reverb = new Tone.Reverb({ decay: 1.25, preDelay: 0.035, wet: 0.3 }).connect(gain);
      filter = new Tone.Filter({ type: "lowpass", frequency: 2100, rolloff: -12 }).connect(reverb);
      synth = new Tone.Synth({
        oscillator: { type: "sine" },
        envelope: { attack: 0.02, decay: 0.16, sustain: 0.12, release: 0.36 },
      }).connect(filter);
    }).catch(() => { audioReady = undefined; });
    void audioReady.then(() => {
      if (!synth) return;
      const [from, to, duration] = notes[sound];
      synth.frequency.setValueAtTime(from, Tone.now());
      synth.frequency.rampTo(to, duration);
      synth.triggerAttackRelease(from, duration);
    });
  } catch {
    // Audio cues are optional and must never interrupt an app action.
  }
}
