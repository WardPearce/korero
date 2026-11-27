<script lang="ts">
  import { resolve } from "$app/paths";
  import { ChevronDown, Settings2 } from "@lucide/svelte";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { buttonVariants } from "#lib/components/ui/button/index.js";
  import { untrack } from "svelte";
  import { getAudioSettings } from "#lib/media/audio.svelte";
  import AudioDeviceFields from "./AudioDeviceFields.svelte";

  let { direction }: { direction: "input" | "output" } = $props();
  const audio = getAudioSettings();
  let label = $derived(direction === "input" ? "Quick microphone settings" : "Quick playback settings");
</script>

<span class="quick-audio">
  <Popover.Root>
    <Popover.Trigger aria-label={label} title={label}
      class={buttonVariants({ variant: "outline", size: "icon", class: "h-(--control-height) w-8 rounded-s-none" })}>
      <ChevronDown size={14} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Content aria-label={label} align="start"
      class="w-64 max-w-[calc(100vw-1.5rem)] max-h-[min(24rem,var(--bits-popover-content-available-height))] overflow-auto"
      {@attach () => { void untrack(() => audio.refreshDevices()); }}>
      <AudioDeviceFields {direction} />
      {#if !audio.available}<p class="field-hint">Available in the VNX.chat desktop app.</p>{/if}
      {#if audio.error || audio.deviceError}<p role="status" class="form-error">{audio.error || audio.deviceError}</p>{/if}
      <a class="audio-settings-link" href={resolve("/settings/audio")}><Settings2 size={15} aria-hidden="true" /> Audio settings</a>
    </Popover.Content>
  </Popover.Root>
</span>
