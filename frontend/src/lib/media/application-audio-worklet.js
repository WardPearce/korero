const prebufferFrames = 2400;
const capacityFrames = 9600;

class ApplicationAudioPlayer extends AudioWorkletProcessor {
  samples = new Int16Array(capacityFrames * 2);
  offset = 0;
  frames = 0;
  playing = false;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      const chunk = new Int16Array(data);
      const frames = chunk.length / 2;
      const skipped = Math.max(this.frames + frames - capacityFrames, 0);
      const end = (this.offset + this.frames) % capacityFrames * 2;
      const head = chunk.subarray(0, this.samples.length - end);
      this.samples.set(head, end);
      this.samples.set(chunk.subarray(head.length), 0);
      this.offset = (this.offset + skipped) % capacityFrames;
      this.frames += frames - skipped;
    };
  }

  /** @param {Float32Array[][]} _inputs @param {Float32Array[][]} outputs */
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.playing && this.frames < prebufferFrames) return true;
    const frames = Math.min(this.frames, left.length);
    for (let frame = 0; frame < frames; frame++) {
      const sample = (this.offset + frame) % capacityFrames * 2;
      left[frame] = this.samples[sample] / 32768;
      right[frame] = this.samples[sample + 1] / 32768;
    }
    this.offset = (this.offset + frames) % capacityFrames;
    this.frames -= frames;
    this.playing = frames === left.length;
    return true;
  }
}

registerProcessor("korero-application-audio", ApplicationAudioPlayer);
