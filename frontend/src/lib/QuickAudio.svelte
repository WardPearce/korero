<script lang="ts">
  import { resolve } from "$app/paths";
  import { ChevronDown, Settings2 } from "@lucide/svelte";
  import { Popover } from "gridworkdesign";
  import { untrack } from "svelte";
  import { getAudioSettings } from "./audio.svelte";
  import AudioDeviceFields from "./AudioDeviceFields.svelte";

  let { direction }: { direction: "input" | "output" } = $props();
  const audio = getAudioSettings();
  let label = $derived(direction === "input" ? "Quick microphone settings" : "Quick playback settings");
</script>

<span class="quick-audio">
  <Popover trigger={label}>
    <div class="audio-popover" {@attach () => { void untrack(() => audio.refreshDevices()); }}>
      <AudioDeviceFields {direction} />
      {#if !audio.available}<p class="field-hint">Available in the VNX.chat app.</p>{/if}
      {#if audio.error || audio.deviceError}<p role="status" class="form-error">{audio.error || audio.deviceError}</p>{/if}
      <a class="audio-settings-link" href={resolve("/settings/audio")}><Settings2 size={15} aria-hidden="true" /> Audio settings</a>
    </div>
  </Popover>
  <ChevronDown size={14} aria-hidden="true" />
</span>
