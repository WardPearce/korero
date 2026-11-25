<script lang="ts">
  import { resolve } from "$app/paths";
  import { Popover } from "bits-ui";
  import { Headphones, Mic, Settings2 } from "lucide-svelte";
  import { getAudioSettings } from "./audio.svelte";
  import AudioDeviceFields from "./AudioDeviceFields.svelte";

  const audio = getAudioSettings();
  const menus = [
    { direction: "input", label: "Quick microphone settings", icon: Mic },
    { direction: "output", label: "Quick playback settings", icon: Headphones },
  ] as const;
</script>

{#each menus as { direction, label, icon: Icon } (direction)}
  <Popover.Root onOpenChange={(open) => { if (open) void audio.refreshDevices(); }}>
    <Popover.Trigger class="icon-button rail-icon" aria-label={label} title={label}><Icon size={15} /></Popover.Trigger>
    <Popover.Portal>
      <Popover.Content side="top" align="start" sideOffset={8} class="audio-popover" aria-label={label}>
        <AudioDeviceFields {direction} />
        {#if !audio.available}<p class="mt-2 text-xs text-(--muted)">Available in the Kōrero app.</p>{/if}
        {#if audio.error || audio.deviceError}<p role="status" class="mt-2 text-xs text-(--danger)">{audio.error || audio.deviceError}</p>{/if}
        <Popover.Close>
          {#snippet child({ props })}
            <a {...props} class="audio-settings-link" href={resolve("/settings/audio")}><Settings2 size={15} /> Audio settings</a>
          {/snippet}
        </Popover.Close>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{/each}
