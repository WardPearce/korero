declare const currentTime: number;
declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(name: string, processor: new (options: { processorOptions: { profile: import("../preferences").AudioPreferences; whisper: boolean } }) => AudioWorkletProcessor): void;
