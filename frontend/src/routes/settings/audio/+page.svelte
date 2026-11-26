<script lang="ts">
  import { Button, Checkbox, SelectField } from "gridworkdesign";
  import { Headphones, Mic, Radio, SlidersHorizontal } from "@lucide/svelte";
  import { onMount } from "svelte";
  import AudioDeviceFields from "$lib/AudioDeviceFields.svelte";
  import AudioLevel from "$lib/AudioLevel.svelte";
  import { getAudioSettings } from "$lib/audio.svelte";
  import { getWorkspace } from "$lib/workspace";

  const audio = getAudioSettings();
  const workspace = getWorkspace();
  let inVoice = $derived(Boolean(workspace.view.snapshot?.channelId));
  let disabled = $derived(!audio.available || audio.applying || audio.testing);
  const inputModes = [
    { mode: "open", value: "Open microphone", label: "Open microphone" },
    { mode: "activity", value: "Voice activity", label: "Voice activity" },
    { mode: "pushToTalk", value: "Push-to-talk", label: "Push-to-talk" },
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
        <Button disabled={!audio.available || audio.testing} onclick={() => audio.refreshDevices()}>Refresh devices</Button>
      </div>
      <div class="audio-device-grid">
        <AudioDeviceFields direction="input" />
        <AudioDeviceFields direction="output" />
      </div>
      <div class="mic-test">
        <div>
          <h3>Microphone test</h3>
          <p>{inVoice ? "Leave the voice channel to run a microphone test." : audio.devices && !audio.devices.micTest ? "Microphone testing is unavailable on this device." : "Speak for two seconds to measure your peak input level."}</p>
        </div>
        <Button disabled={disabled || inVoice || !audio.devices?.micTest} onclick={() => audio.test()}>
          <Mic size={15} /> {audio.testing ? "Listening…" : "Test microphone"}
        </Button>
        {#if audio.peak !== null}
          <div class="mic-result" role="status">
            <meter min="0" max="1" value={audio.peak} aria-label="Peak microphone level"></meter>
            <span>{Math.round(audio.peak * 100)}% peak</span>
          </div>
        {/if}
      </div>
    </section>

    <section class="settings-card audio-card audio-fields" aria-labelledby="audio-transmission">
      <h2 id="audio-transmission"><Radio size={16} /> Transmission</h2>
      <SelectField label="Input mode" options={[...inputModes]} {disabled}
        bind:value={() => inputMode, selectInputMode} />
      {#if audio.profile.transmitMode === "pushToTalk"}
        <p class="field-hint">Hold <kbd>Alt</kbd> + <kbd>V</kbd> while the VNX.chat window is focused.</p>
      {:else if audio.profile.transmitMode === "activity"}
        <AudioLevel setting="activityThreshold" label="Microphone activation level (%)" min={1} />
      {/if}
    </section>

    <section class="settings-card audio-card" aria-labelledby="audio-processing">
      <h2 id="audio-processing"><SlidersHorizontal size={16} /> Processing</h2>
      {#each processing as item (item.key)}
        <div class="audio-toggle">
          <Checkbox label={item.label} {disabled}
            bind:checked={() => audio.profile[item.key], (checked) => { void audio.update(item.key, checked); }} />
          <small>{item.description}</small>
        </div>
      {/each}
    </section>
  </div>
</main>
