<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import { AudioLines, Headphones, Mic, Radio, SlidersHorizontal } from "@lucide/svelte";
  import { onMount } from "svelte";
  import AudioDeviceFields from "#lib/components/media/AudioDeviceFields.svelte";
  import AudioLevel from "#lib/components/media/AudioLevel.svelte";
  import TalkKey from "#lib/components/media/TalkKey.svelte";
  import { getAudioSettings } from "#lib/media/audio.svelte";
  import { getWorkspace } from "#lib/workspace";

  const audio = getAudioSettings();
  const workspace = getWorkspace();
  let inVoice = $derived(Boolean(workspace.view.snapshot?.channelId));
  let disabled = $derived(!audio.available || audio.applying || audio.testing);
  let gatePeakDb = $derived(Math.max(-80, Math.round(20 * Math.log10(audio.sample?.gatePeak ?? 0))));
  const inputModes = [
    { mode: "open", value: "Open microphone", label: "Open microphone" },
    { mode: "activity", value: "Voice activity", label: "Voice activity" },
    { mode: "pushToTalk", value: "Push-to-talk", label: "Push-to-talk" },
    { mode: "toggleToTalk", value: "Toggle-to-talk", label: "Toggle-to-talk" },
  ] as const;
  let inputMode = $derived(inputModes.find(({ mode }) => mode === audio.profile.transmitMode)?.value ?? inputModes[0].value);

  function selectInputMode(value: string) {
    const choice = inputModes.find((option) => option.value === value);
    if (choice && choice.mode !== audio.profile.transmitMode) void audio.update("transmitMode", choice.mode);
  }

  const processing = [
    { key: "noiseSuppression", label: "Noise suppression", description: "Reduce steady background noise in the microphone signal." },
    { key: "automaticGain", label: "Automatic gain control", description: "Adjust the microphone signal when your voice gets louder or quieter." },
    { key: "echoCancellation", label: "Echo cancellation", description: "Reduce playback audio picked up by your microphone." },
  ] as const;

  function attachRecording(element: HTMLAudioElement) {
    const recording = audio.sample?.recording;
    if (!recording) return;
    const source = URL.createObjectURL(recording);
    element.src = source;
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(source);
    };
  }

  onMount(() => { void audio.refreshDevices(); });
</script>

<svelte:head><title>Audio settings · VNX.chat</title></svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Headphones size={19} /></div><h1>Audio</h1></header>
  <div class="workspace">
    {#if !audio.available}
      <p class="notice" role="status">Native audio controls are available in the VNX.chat app.</p>
    {:else if audio.error || audio.deviceError}
      <p class="notice" role="status">{audio.error || audio.deviceError}</p>
    {/if}

    <section class="settings-card audio-card" aria-labelledby="audio-devices">
      <div class="audio-card-heading">
        <h2 id="audio-devices"><Headphones size={16} /> Devices</h2>
        <Button variant="outline" disabled={!audio.available || audio.testing} onclick={() => audio.refreshDevices()}>Refresh devices</Button>
      </div>
      <div class="audio-device-grid">
        <AudioDeviceFields direction="input" />
        <AudioDeviceFields direction="output" />
      </div>
    </section>

    <section class="settings-card audio-card audio-fields" aria-labelledby="audio-transmission">
      <h2 id="audio-transmission"><Radio size={16} /> Transmission</h2>
      <SelectField label="Input mode" options={[...inputModes]} {disabled}
        bind:value={() => inputMode, selectInputMode} />
      {#if audio.profile.transmitMode === "pushToTalk" || audio.profile.transmitMode === "toggleToTalk"}
        <div class="audio-toggle">
          <TalkKey shortcut={audio.profile.talkShortcut} {disabled} onchange={(shortcut) => void audio.update("talkShortcut", shortcut)} />
          <small>{audio.profile.transmitMode === "pushToTalk" ? "Hold the shortcut to transmit." : "Press once to transmit and again to stop."}</small>
        </div>
        <Checkbox label="System-wide talk shortcut" {disabled}
          bind:checked={() => audio.profile.globalTalkShortcut, (checked) => { void audio.update("globalTalkShortcut", checked); }} />
        <p class="field-hint" role="status">{audio.shortcutError || (audio.globalActive ? "The shortcut works while other apps are focused." : "The shortcut works while VNX.chat is focused.")}</p>
        {#if audio.talking}
          <p class="field-hint" role="status">Transmitting microphone audio</p>
        {/if}
      {:else if audio.profile.transmitMode === "activity"}
        <AudioLevel setting="activityThreshold" label="Microphone activation level (%)" min={1} />
        <AudioLevel setting="activityHoldMs" label="Voice activity hold" max={1000} step={10} unit="ms" />
        <small>Keep transmitting briefly after your level falls below the activation threshold.</small>
      {/if}
    </section>

    <section class="settings-card audio-card" aria-labelledby="audio-processing">
      <h2 id="audio-processing"><SlidersHorizontal size={16} /> Processing</h2>
      <div class="audio-toggle">
        <Checkbox label="Noise gate" {disabled}
          bind:checked={() => audio.profile.noiseGate, (checked) => { void audio.update("noiseGate", checked); }} />
        <small>Turn down quiet sounds between words, even when the microphone is open.</small>
        {#if audio.profile.noiseGate}
          <div class="gate-fields">
            <AudioLevel setting="gateThresholdDb" label="Gate threshold" min={-80} max={-5} unit="dBFS" />
            <small>Raise the threshold until background sounds stay below it and speech still opens the gate.</small>
            <AudioLevel setting="gateAttenuationDb" label="Closed attenuation" max={60} unit="dB" />
            <small>Higher attenuation makes the background quieter when the gate closes.</small>
            <AudioLevel setting="gateHoldMs" label="Gate hold" max={1000} step={10} unit="ms" />
            <small>Keep the gate open through short pauses in speech.</small>
          </div>
        {/if}
      </div>
      {#each processing as item (item.key)}
        <div class="audio-toggle">
          <Checkbox label={item.label} {disabled}
            bind:checked={() => audio.profile[item.key], (checked) => { void audio.update(item.key, checked); }} />
          <small>{item.description}</small>
        </div>
      {/each}
    </section>

    <section class="settings-card audio-card audio-fields" aria-labelledby="audio-test">
      <div class="audio-card-heading">
        <h2 id="audio-test"><Mic size={16} /> Microphone test</h2>
        <Button variant="outline" disabled={disabled || inVoice || !audio.devices?.micTest} onclick={() => audio.test()}>
          <AudioLines size={15} /> {audio.testing ? "Recording…" : "Record sample"}
        </Button>
      </div>
      <small role="status">{inVoice
        ? "Leave the voice channel to record a sample."
        : audio.available && audio.devices && !audio.devices.micTest
          ? "Microphone testing is unavailable on this device."
          : audio.testing ? "Speak now." : "Record a three-second sample to check how your settings affect speech and background sound."}</small>
      {#if audio.sample && !inVoice}
        <div class="recording-result">
          <div class="peak-reading" role="status">
            <span>Peak before gate</span>
            <span>{gatePeakDb <= -80 ? "≤ −80" : gatePeakDb} dBFS</span>
          </div>
          <meter min={-80} max={0} value={gatePeakDb} aria-label="Peak level before gate in dBFS"></meter>
          <audio controls controlslist="nodownload noplaybackrate" preload="metadata" aria-label="Microphone sample" {@attach attachRecording}></audio>
          <small>Playback uses your system audio output.</small>
        </div>
      {/if}
    </section>
  </div>
</main>

<style>
  .gate-fields, .recording-result { display: grid; width: 100%; gap: 8px; }
  .gate-fields { margin-block-start: 8px; padding-inline-start: 12px; border-inline-start: 1px solid var(--border); }
  .peak-reading { display: flex; justify-content: space-between; gap: 12px; font-size: var(--type-small); }
  meter, audio { width: 100%; }
</style>
