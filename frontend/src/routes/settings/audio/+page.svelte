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
  const inputModes = [
    { mode: "open", value: "Open microphone", label: "Open microphone" },
    { mode: "activity", value: "Voice activity", label: "Voice activity" },
    { mode: "pushToTalk", value: "Push-to-talk", label: "Push-to-talk" },
    { mode: "toggleToTalk", value: "Toggle-to-talk", label: "Toggle-to-talk" },
  ] as const;
  let inputMode = $derived(inputModes.find(({ mode }) => mode === audio.profile.transmitMode)?.value ?? inputModes[0].value);
  let monitorStream: MediaStream | undefined = $state();
  let monitorContext: AudioContext | undefined = $state();
  let liveLevel = $state(0);
  let liveTransmitting = $state(false);
  let monitorError = $state("");
  let monitorFrame = 0;
  let belowSince = 0;
  let mutedForPreview = false;

  function selectInputMode(value: string) {
    const choice = inputModes.find((option) => option.value === value);
    if (choice && choice.mode !== audio.profile.transmitMode) void audio.update("transmitMode", choice.mode);
  }

  const processing = [
    { key: "noiseSuppression", label: "Noise suppression", description: "Reduce steady background noise in the microphone signal." },
    { key: "automaticGain", label: "Automatic gain control", description: "Adjust the microphone signal when your voice gets louder or quieter." },
    { key: "echoCancellation", label: "Echo cancellation", description: "Reduce playback audio picked up by your microphone." },
  ] as const;

  async function toggleMonitor() {
    if (monitorStream) { stopMonitor(); return; }
    monitorError = "";
    try {
      if (inVoice) {
        const ownMember = workspace.view.snapshot?.members.find((member) => member.connectionId === workspace.view.snapshot?.connectionId);
        if (!ownMember) throw new Error("Could not read your voice mute state.");
        mutedForPreview = !ownMember.muted && !ownMember.adminMuted;
        if (mutedForPreview && !await workspace.run("mute", "set_presence", { muted: true, deafened: null })) {
          mutedForPreview = false;
          throw new Error(workspace.actionError || "Could not mute your voice channel microphone.");
        }
      }
      // The monitor plays its own input, which echo cancellation can suppress.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: audio.profile.input ? { exact: audio.profile.input } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      source.connect(context.destination);
      monitorStream = stream;
      monitorContext = context;
      const samples = new Uint8Array(analyser.fftSize);
      const updateMeter = () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128);
        liveLevel = Math.round(peak * 100);
        const overThreshold = peak >= audio.profile.activityThreshold / 100;
        if (audio.profile.transmitMode === "activity") {
          if (overThreshold) { liveTransmitting = true; belowSince = 0; }
          else if (liveTransmitting) {
            belowSince ||= performance.now();
            if (performance.now() - belowSince >= audio.profile.activityHoldMs) liveTransmitting = false;
          }
        } else liveTransmitting = audio.profile.transmitMode === "open" || audio.talking;
        monitorFrame = requestAnimationFrame(updateMeter);
      };
      updateMeter();
    } catch (error) {
      monitorError = error instanceof Error ? error.message : "Could not access the microphone.";
      if (mutedForPreview) { mutedForPreview = false; void workspace.run("mute", "set_presence", { muted: false, deafened: null }); }
    }
  }

  function stopMonitor() {
    cancelAnimationFrame(monitorFrame);
    monitorStream?.getTracks().forEach((track) => track.stop());
    void monitorContext?.close();
    monitorStream = undefined;
    monitorContext = undefined;
    liveLevel = 0;
    liveTransmitting = false;
    if (mutedForPreview) {
      mutedForPreview = false;
      void workspace.run("mute", "set_presence", { muted: false, deafened: null });
    }
  }

  onMount(() => { void audio.refreshDevices(); return stopMonitor; });
</script>

<svelte:head><title>Audio settings · Korero.chat</title></svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Headphones size={19} /></div><h1>Audio</h1></header>
  <div class="workspace">
    {#if !audio.available}
      <p class="notice" role="status">Audio device and processing settings are available in the Korero.chat desktop app.</p>
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
        <p class="field-hint" role="status">{audio.shortcutError || (audio.globalActive ? "The shortcut works while other apps are focused." : "The shortcut works while Korero.chat is focused.")}</p>
        {#if audio.talking}
          <p class="field-hint" role="status">Transmitting microphone audio</p>
        {/if}
      {:else if audio.profile.transmitMode === "activity"}
        <AudioLevel setting="activityThreshold" label="Microphone activation level (%)" min={1} />
        <AudioLevel setting="activityHoldMs" label="Voice activity hold" max={1000} step={10} unit="ms" />
        <div class="live-preview" aria-live="polite">
          <div class="peak-reading"><span>Live microphone preview</span><span>{monitorStream ? `${liveLevel}%` : "Not listening"}</span></div>
          <meter min="0" max="100" value={liveLevel} aria-label="Live microphone level"></meter>
          <small>{monitorStream
            ? liveTransmitting ? "Above threshold · voice activity open" : "Below threshold · voice activity closed"
            : "Start the microphone monitor below to preview voice activity while adjusting the threshold."}</small>
          {#if !monitorStream}
            <Button variant="outline" disabled={disabled || typeof navigator === "undefined" || !navigator.mediaDevices} onclick={toggleMonitor}>
              <AudioLines size={15} /> Listen to microphone
            </Button>
          {/if}
        </div>
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
        <h2 id="audio-test"><Mic size={16} /> Microphone monitor</h2>
        <Button variant="outline" disabled={disabled || typeof navigator === "undefined" || !navigator.mediaDevices} onclick={toggleMonitor}>
          <AudioLines size={15} /> {monitorStream ? "Stop listening" : "Listen to microphone"}
        </Button>
      </div>
      <small role="status">{inVoice ? "Your voice channel microphone will be muted while previewing." : "Listen to your microphone in real time and watch its level and voice activity state."}</small>
      {#if monitorStream}
        <div class="recording-result">
          <div class="peak-reading" role="status">
            <span>Input level</span>
            <span>{liveLevel}%</span>
          </div>
          <meter min="0" max="100" value={liveLevel} aria-label="Live microphone level"></meter>
          <p class="field-hint" role="status">{audio.profile.transmitMode === "activity"
            ? liveTransmitting ? "Voice activity · transmitting" : "Below activation threshold · cutoff"
            : audio.profile.transmitMode === "open" ? "Open microphone · transmitting" : audio.talking ? "Talk control active · transmitting" : "Talk control inactive · cutoff"}</p>
        </div>
      {/if}
      {#if monitorError}<p class="field-hint" role="alert">{monitorError}</p>{/if}
    </section>
  </div>
</main>

<style>
  .gate-fields, .recording-result, .live-preview { display: grid; width: 100%; gap: 8px; }
  .gate-fields { margin-block-start: 8px; padding-inline-start: 12px; border-inline-start: 1px solid var(--border); }
  .peak-reading { display: flex; justify-content: space-between; gap: 12px; font-size: var(--type-small); }
  meter, audio { width: 100%; }
</style>
