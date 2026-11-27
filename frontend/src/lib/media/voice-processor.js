class VoiceProcessor extends AudioWorkletProcessor {
  /** @param {{ processorOptions: { profile: import("../preferences").AudioPreferences; whisper: boolean } }} options */
  constructor({ processorOptions: { profile, whisper } }) {
    super();
    this.profile = profile;
    this.whisper = whisper;
    this.activityUntil = 0;
    this.gateUntil = 0;
    this.gateOpen = false;
    this.gain = 0;
    this.talkUntil = 0;
    this.port.onmessage = ({ data }) => {
      if (typeof data === "boolean") {
        this.talkUntil = data ? currentTime + 0.65 : 0;
      } else {
        this.profile = data;
        this.activityUntil = 0;
        this.gateUntil = 0;
        this.gateOpen = false;
      }
    };
  }

  /** @param {Float32Array[][]} inputs @param {Float32Array[][]} outputs */
  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input || !output) return true;
    const profile = this.profile;
    const mode = profile.transmitMode;
    const level = profile.inputLevel / 100;
    const needsTalk = this.whisper || mode === "pushToTalk" || mode === "toggleToTalk";
    if (needsTalk && currentTime >= this.talkUntil) {
      this.gain = 0;
      output.fill(0);
      return true;
    }

    let peak = 0;
    for (const sample of input) peak = Math.max(peak, Math.abs(sample) * level);
    const aboveActivity = peak >= profile.activityThreshold / 100;
    if (aboveActivity) this.activityUntil = currentTime + profile.activityHoldMs / 1000;
    const active = this.whisper || mode !== "activity" || aboveActivity || currentTime < this.activityUntil;
    const threshold = 10 ** ((profile.gateThresholdDb - (this.gateOpen ? 3 : 0)) / 20);
    if (peak >= threshold) this.gateUntil = currentTime + profile.gateHoldMs / 1000;
    this.gateOpen = peak >= threshold || currentTime < this.gateUntil;
    const gain = !active ? 0 : profile.noiseGate && !this.gateOpen ? 10 ** (-profile.gateAttenuationDb / 20) : 1;
    const step = (gain - this.gain) / output.length;
    for (let i = 0; i < output.length; i++) {
      output[i] = input[i] * level * (this.gain + step * (i + 1));
    }
    this.gain = gain;
    return true;
  }
}

registerProcessor("korero-voice", VoiceProcessor);
