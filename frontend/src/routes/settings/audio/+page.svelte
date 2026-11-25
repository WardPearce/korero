<script lang="ts">
  import { Headphones, Mic, Radio, SlidersHorizontal } from "lucide-svelte";
  import { onMount } from "svelte";
  import AudioDeviceFields from "$lib/AudioDeviceFields.svelte";
  import { getAudioSettings } from "$lib/audio.svelte";
  import { getWorkspace } from "$lib/workspace";

  const audio = getAudioSettings();
  const workspace = getWorkspace();
  let inVoice = $derived(Boolean(workspace.view.snapshot?.channelId));
  let disabled = $derived(!audio.available || audio.applying || audio.testing);
  const processing = [
    { key: "noiseSuppression", label: "Noise suppression", description: "Reduce steady background noise in the microphone signal." },
    { key: "automaticGain", label: "Automatic gain control", description: "Adjust the microphone signal when your voice gets louder or quieter." },
    { key: "echoCancellation", label: "Echo cancellation", description: "Reduce playback audio picked up by your microphone." },
  ] as const;

  onMount(() => { void audio.refreshDevices(); });
</script>

<svelte:head><title>Audio settings · Kōrero</title></svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Headphones size={19} /></div><h1>Audio</h1></header>
  <div class="workspace">
    {#if !audio.available}
      <p class="notice" role="status">Native audio controls are available in the Kōrero app.</p>
    {:else if audio.error || audio.deviceError}
      <p class="notice" role="status">{audio.error || audio.deviceError}</p>
    {/if}

    <section class="settings-card audio-card" aria-labelledby="audio-devices">
      <div class="audio-card-heading">
        <h2 id="audio-devices"><Headphones size={16} /> Devices</h2>
        <button class="secondary-button" disabled={!audio.available || audio.testing} onclick={() => audio.refreshDevices()}>Refresh devices</button>
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
        <button class="secondary-button" disabled={disabled || inVoice || !audio.devices?.micTest} onclick={() => audio.test()}>
          <Mic size={15} /> {audio.testing ? "Listening…" : "Test microphone"}
        </button>
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
      <label>
        Input mode
        <select value={audio.profile.transmitMode} {disabled}
          onchange={(event) => audio.update("transmitMode", event.currentTarget.value as typeof audio.profile.transmitMode)}>
          <option value="open">Open microphone</option>
          <option value="activity">Voice activity</option>
          <option value="pushToTalk">Push-to-talk</option>
        </select>
      </label>
      {#if audio.profile.transmitMode === "pushToTalk"}
        <p class="text-(--muted)">Hold <kbd>Alt</kbd> + <kbd>V</kbd> while the Kōrero window is focused.</p>
      {:else if audio.profile.transmitMode === "activity"}
        <label>
          <span>Microphone activation level ({audio.profile.activityThreshold}%)</span>
          <input type="range" min="1" max="100" value={audio.profile.activityThreshold} {disabled}
            onchange={async (event) => {
              const slider = event.currentTarget;
              await audio.update("activityThreshold", slider.valueAsNumber);
              slider.valueAsNumber = audio.profile.activityThreshold;
            }} />
        </label>
      {/if}
    </section>

    <section class="settings-card audio-card" aria-labelledby="audio-processing">
      <h2 id="audio-processing"><SlidersHorizontal size={16} /> Processing</h2>
      {#each processing as item (item.key)}
        <label class="audio-toggle">
          <span><strong>{item.label}</strong><small>{item.description}</small></span>
          <input type="checkbox" checked={audio.profile[item.key]} {disabled}
            onchange={async (event) => {
              const checkbox = event.currentTarget;
              await audio.update(item.key, checkbox.checked);
              checkbox.checked = audio.profile[item.key];
            }} />
        </label>
      {/each}
    </section>
  </div>
</main>
