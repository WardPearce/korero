import * as Tone from "tone";

type Sound = "channel" | "connect" | "disconnect" | "mute" | "unmute" | "deafen" | "undeafen" | "message" | "directMessage"
  | "poke" | "afk" | "back" | "screenShareStart" | "screenShareStop" | "cameraStart" | "cameraStop";

/**
 * Each cue is a short phrase rather than a single glide, so families of sounds stay recognisable:
 * - bell: soft FM chime for things other people do (messages, pokes, camera).
 * - pluck: dry, clicky triangle for your own toggles (mute, deafen).
 * - pad: warm detuned sine for session state (connect, AFK).
 * - knock: a pitched thump that asks for attention.
 * Turning something on rises and turning it off falls; everything sits in C major so overlapping cues stay consonant.
 */
type Instrument = "bell" | "pluck" | "pad" | "knock";
type Note = [instrument: Instrument, pitch: string, at: number, length: number, velocity: number];
type Cue = { notes: Note[]; swish?: "up" | "down" };

const cues: Record<Sound, Cue> = {
  connect: { notes: [["pad", "C4", 0, 0.5, 0.5], ["bell", "C5", 0, 0.3, 0.45], ["bell", "E5", 0.08, 0.3, 0.45], ["bell", "G5", 0.16, 0.45, 0.5]] },
  disconnect: { notes: [["bell", "G5", 0, 0.25, 0.4], ["bell", "E5", 0.08, 0.25, 0.4], ["bell", "C5", 0.16, 0.4, 0.4], ["pad", "C4", 0.16, 0.45, 0.4]] },
  channel: { swish: "up", notes: [["pluck", "E5", 0.03, 0.1, 0.45], ["bell", "A5", 0.1, 0.3, 0.4]] },
  mute: { notes: [["pluck", "A4", 0, 0.07, 0.6], ["pluck", "E4", 0.07, 0.1, 0.55]] },
  unmute: { notes: [["pluck", "E4", 0, 0.07, 0.55], ["pluck", "A4", 0.07, 0.1, 0.6]] },
  deafen: { notes: [["pluck", "D4", 0, 0.08, 0.6], ["pluck", "A3", 0.08, 0.14, 0.6], ["pad", "A2", 0.08, 0.25, 0.35]] },
  undeafen: { notes: [["pad", "A2", 0, 0.2, 0.3], ["pluck", "A3", 0, 0.08, 0.6], ["pluck", "D4", 0.08, 0.14, 0.6]] },
  message: { notes: [["bell", "A5", 0, 0.12, 0.3], ["bell", "E6", 0.06, 0.22, 0.25]] },
  directMessage: { notes: [["bell", "E5", 0, 0.18, 0.5], ["bell", "G5", 0.09, 0.18, 0.5], ["bell", "C6", 0.18, 0.5, 0.55]] },
  poke: { notes: [["knock", "G2", 0, 0.12, 0.8], ["knock", "G2", 0.13, 0.12, 0.65], ["bell", "G6", 0.26, 0.35, 0.4], ["bell", "D6", 0.26, 0.35, 0.3]] },
  afk: { notes: [["bell", "E5", 0, 0.3, 0.4], ["pad", "E4", 0, 0.35, 0.45], ["bell", "C5", 0.2, 0.3, 0.35], ["pad", "C4", 0.2, 0.35, 0.4],
    ["bell", "G4", 0.4, 0.5, 0.3], ["pad", "G3", 0.4, 0.6, 0.35]] },
  back: { notes: [["pad", "G3", 0, 0.3, 0.35], ["pad", "C4", 0.15, 0.3, 0.4], ["bell", "E5", 0.3, 0.4, 0.4]] },
  screenShareStart: { swish: "up", notes: [["pluck", "G4", 0.05, 0.08, 0.45], ["pluck", "C5", 0.12, 0.08, 0.5], ["bell", "G5", 0.19, 0.35, 0.45]] },
  screenShareStop: { swish: "down", notes: [["bell", "G5", 0, 0.2, 0.35], ["pluck", "C5", 0.08, 0.08, 0.45], ["pluck", "G4", 0.15, 0.12, 0.45]] },
  cameraStart: { notes: [["bell", "D5", 0, 0.2, 0.4], ["bell", "A5", 0.08, 0.35, 0.45]] },
  cameraStop: { notes: [["bell", "A5", 0, 0.2, 0.4], ["bell", "D5", 0.08, 0.35, 0.4]] },
};

type Voices = {
  instruments: Record<Instrument, Tone.PolySynth>;
  swish: Tone.NoiseSynth;
  swishFilter: Tone.Filter;
};

/** Repeats of one cue inside this window (e.g. several streams appearing at once) play only once. */
const repeatWindowMs = 90;
const lastPlayed = new Map<Sound, number>();
let voicesReady: Promise<Voices> | undefined;

async function createVoices(): Promise<Voices> {
  await Tone.start();
  const output = new Tone.Gain(0.55).toDestination();
  const limiter = new Tone.Limiter(-8).connect(output);
  const reverb = new Tone.Reverb({ decay: 0.9, preDelay: 0.012, wet: 0.16 }).connect(limiter);
  const tone = new Tone.Filter({ type: "lowpass", frequency: 5200, rolloff: -12 }).connect(reverb);
  await reverb.ready;

  const instruments: Record<Instrument, Tone.PolySynth> = {
    bell: new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 1.6,
      oscillator: { type: "sine" },
      modulation: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.45, sustain: 0, release: 0.5 },
      modulationEnvelope: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.2 },
      volume: -9,
    }).connect(tone),
    pluck: new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.003, decay: 0.12, sustain: 0, release: 0.1 },
      volume: -5,
    }).connect(tone),
    pad: new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsine", count: 3, spread: 14 },
      envelope: { attack: 0.03, decay: 0.3, sustain: 0.35, release: 0.45 },
      volume: -12,
    }).connect(tone),
    knock: new Tone.PolySynth(Tone.MembraneSynth, {
      pitchDecay: 0.03,
      octaves: 3,
      envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.05 },
      volume: -4,
    }).connect(limiter),
  };

  const swishFilter = new Tone.Filter({ type: "bandpass", frequency: 1200, Q: 1.4 }).connect(tone);
  const swish = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.06, decay: 0.16, sustain: 0, release: 0.06 },
    volume: -24,
  }).connect(swishFilter);

  return { instruments, swish, swishFilter };
}

/** Plays a short synthesized UI cue; Tone's audio context starts on the user's gesture. */
export function playUiSound(sound: Sound) {
  const now = performance.now();
  if (now - (lastPlayed.get(sound) ?? -Infinity) < repeatWindowMs) return;
  lastPlayed.set(sound, now);

  try {
    voicesReady ??= createVoices().catch((error) => {
      voicesReady = undefined;
      throw error;
    });
    void voicesReady.then(({ instruments, swish, swishFilter }) => {
      const cue = cues[sound];
      const start = Tone.now() + 0.01;
      if (cue.swish) {
        const [from, to] = cue.swish === "up" ? [500, 3200] : [3200, 500];
        swishFilter.frequency.setValueAtTime(from, start);
        swishFilter.frequency.exponentialRampToValueAtTime(to, start + 0.22);
        swish.triggerAttackRelease(0.16, start);
      }
      for (const [instrument, pitch, at, length, velocity] of cue.notes) {
        instruments[instrument].triggerAttackRelease(pitch, length, start + at, velocity);
      }
    }).catch(() => {});
  } catch {
    // Audio cues are optional and must never interrupt an app action.
  }
}
