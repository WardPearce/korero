<script lang="ts">
  import { resolve } from "$app/paths";
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import { AudioLines, Headphones, Keyboard, Radio, SlidersHorizontal } from "@lucide/svelte";
  import { onMount } from "svelte";
  import AudioDeviceFields from "#lib/components/media/AudioDeviceFields.svelte";
  import AudioLevel from "#lib/components/media/AudioLevel.svelte";
  import AudioMeter from "#lib/components/media/AudioMeter.svelte";
  import { getAudioSettings } from "#lib/media/audio.svelte";
  import { getWorkspace } from "#lib/workspace";

  const audio = getAudioSettings();
  const workspace = getWorkspace();
  let inVoice = $derived(Boolean(workspace.view.snapshot?.channelId));
  let disabled = $derived(!audio.available || audio.applying);
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
  let thresholdPreview = $state<number>();
  let activityThreshold = $derived(thresholdPreview ?? audio.profile.activityThreshold);
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
      // The monitor plays its own input, which echo cancellation would suppress.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: audio.profile.input ? { exact: audio.profile.input } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const context = new AudioContext();
      if (audio.profile.output) {
        try {
          await (context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> })
            .setSinkId?.(audio.profile.output);
        } catch { /* Fall back to the system output. */ }
      }
      await context.resume();
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
  <header class="workspace-header"><div class="heading-icon"><Headphones size={19} aria-hidden="true" /></div><h1>Audio</h1></header>
  <div class="workspace settings-content">
    {#if !audio.available}
      <p class="notice" role="status">Audio device and processing settings are available in the Korero.chat desktop app.</p>
    {:else if audio.error || audio.deviceError}
      <p class="notice" role="status">{audio.error || audio.deviceError}</p>
    {/if}

    <section class="settings-card" aria-labelledby="audio-devices">
      <div class="settings-row">
        <h2 id="audio-devices"><Headphones size={16} aria-hidden="true" /> Devices</h2>
        <Button variant="outline" disabled={!audio.available} onclick={() => audio.refreshDevices()}>Refresh devices</Button>
      </div>
      <div class="audio-device-grid">
        <AudioDeviceFields direction="input" />
        <AudioDeviceFields direction="output" />
      </div>
    </section>

    <section class="settings-card" aria-labelledby="audio-transmission">
      <div class="settings-row">
        <div class="settings-heading">
          <h2 id="audio-transmission"><Radio size={16} aria-hidden="true" /> Transmission</h2>
          {#if inVoice}<p class="field-hint">Your voice channel microphone is muted during the preview.</p>{/if}
        </div>
        <Button variant="outline" disabled={disabled || typeof navigator === "undefined" || !navigator.mediaDevices} onclick={toggleMonitor}>
          <AudioLines size={15} aria-hidden="true" /> {monitorStream ? "Stop listening" : "Listen to microphone"}
        </Button>
      </div>
      {#if monitorError}<p class="form-error" role="alert">{monitorError}</p>{/if}
      <SelectField label="Input mode" options={[...inputModes]} {disabled}
        bind:value={() => inputMode, selectInputMode} />
      {#if audio.profile.transmitMode === "pushToTalk" || audio.profile.transmitMode === "toggleToTalk"}
        <div class="settings-row">
          <p class="field-hint">{audio.profile.transmitMode === "pushToTalk" ? "Hold the shortcut to transmit." : "Press once to transmit and again to stop."}</p>
          <Button variant="outline" href={resolve("/settings/shortcuts")} data-desktop-only><Keyboard size={16} aria-hidden="true" /> Configure talk shortcut</Button>
        </div>
        {#if audio.talking}
          <p class="field-hint" role="status">Transmitting microphone audio</p>
        {/if}
      {:else if audio.profile.transmitMode === "activity"}
        <AudioLevel setting="activityThreshold" label="Microphone activation level (%)" min={1} variant="threshold"
          level={monitorStream ? liveLevel : undefined}
          onpreview={(value) => { thresholdPreview = value; }} />
        <div class="threshold-legend" aria-hidden="true">
          <span><i data-tone="warning"></i>Cut off below {activityThreshold}%</span>
          <span><i data-tone="success"></i>Transmitting above {activityThreshold}%</span>
        </div>
        <div class="activity-preview">
          {#if monitorStream}
            <p class="peak-reading">
              <span class="live-state"><i class={["live-dot", { open: liveTransmitting }]}></i>Live {liveLevel}%</span>
              <span role="status">{liveTransmitting ? "Voice activity open" : "Voice activity closed"}</span>
            </p>
          {:else}
            <p class="field-hint">Use “Listen to microphone” above to preview your live level on the bar.</p>
          {/if}
        </div>
        <div class="audio-option">
          <AudioLevel setting="activityHoldMs" label="Voice activity hold" max={1000} step={10} unit="ms" />
          <p class="field-hint">Keep transmitting briefly after your level falls below the activation threshold.</p>
        </div>
      {/if}
      {#if monitorStream && audio.profile.transmitMode !== "activity"}
        <div class="activity-preview">
          <p class="peak-reading">
            <span class="live-state"><i class={["live-dot", { open: liveTransmitting }]}></i>Live {liveLevel}%</span>
            <span role="status" aria-live="polite">{audio.profile.transmitMode === "open"
              ? "Open microphone · transmitting"
              : audio.talking ? "Talk control active · transmitting" : "Talk control inactive · cutoff"}</span>
          </p>
          <AudioMeter level={liveLevel} active={liveTransmitting} label="Live microphone level" />
        </div>
      {/if}
    </section>

    <section class="settings-card" aria-labelledby="audio-processing">
      <h2 id="audio-processing"><SlidersHorizontal size={16} aria-hidden="true" /> Processing</h2>
      <div class="audio-option">
        <Checkbox label="Noise gate" {disabled}
          bind:checked={() => audio.profile.noiseGate, (checked) => { void audio.update("noiseGate", checked); }} />
        <p class="field-hint">Turn down quiet sounds between words, even when the microphone is open.</p>
        {#if audio.profile.noiseGate}
          <div class="gate-fields">
            <div class="audio-option">
              <AudioLevel setting="gateThresholdDb" label="Gate threshold" min={-80} max={-5} unit="dBFS" />
              <p class="field-hint">Raise the threshold until background sounds stay below it and speech still opens the gate.</p>
            </div>
            <div class="audio-option">
              <AudioLevel setting="gateAttenuationDb" label="Closed attenuation" max={60} unit="dB" />
              <p class="field-hint">Higher attenuation makes the background quieter when the gate closes.</p>
            </div>
            <div class="audio-option">
              <AudioLevel setting="gateHoldMs" label="Gate hold" max={1000} step={10} unit="ms" />
              <p class="field-hint">Keep the gate open through short pauses in speech.</p>
            </div>
          </div>
        {/if}
      </div>
      <div class="processing-options">
        {#each processing as item (item.key)}
          <div class="audio-option">
            <Checkbox label={item.label} {disabled}
              bind:checked={() => audio.profile[item.key], (checked) => { void audio.update(item.key, checked); }} />
            <p class="field-hint">{item.description}</p>
          </div>
        {/each}
      </div>
    </section>

  </div>
</main>

<style>
  h2 { display: flex; align-items: center; gap: .5rem; }
  .audio-device-grid, .processing-options, .gate-fields { display: grid; gap: var(--settings-padding); }
  .audio-device-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
  .processing-options, .gate-fields { grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); }
  .processing-options { padding-block-start: .5rem; border-block-start: 1px solid var(--border); }
  .audio-option, .activity-preview { display: grid; min-width: 0; gap: .25rem; }
  .audio-option :global(.check-control) { font-weight: 600; }
  .gate-fields { margin-block-start: .5rem; padding-inline-start: .75rem; border-inline-start: 1px solid var(--border); }
  .peak-reading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .25rem .75rem; font-size: var(--type-small); }
  .live-state { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .live-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--warning); }
  .live-dot.open { background: var(--success); }
  .threshold-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-block-start: -4px;
    color: var(--muted-foreground);
    font-size: var(--type-caption);
  }
  .threshold-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .threshold-legend i { width: 8px; height: 8px; border-radius: 999px; }
  .threshold-legend i[data-tone="warning"] { background: var(--warning); }
  .threshold-legend i[data-tone="success"] { background: var(--success); }
</style>
