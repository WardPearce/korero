<script lang="ts">
  import { ChevronDown, HeadphoneOff, Headphones, Mic, MicOff, PhoneOff, Speaker } from "@lucide/svelte";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { desktopApp } from "#lib/connection/client";
  import { getAudioSettings } from "#lib/media/audio.svelte";
  import { speakerphone } from "#lib/media/speakerphone.svelte";
  import { getWorkspace } from "#lib/workspace";
  import QuickAudio from "./QuickAudio.svelte";
  import WhisperControls from "./WhisperControls.svelte";

  let { onleave }: { onleave?: () => void } = $props();

  const workspace = getWorkspace();
  const audio = getAudioSettings();
  // A voice session keeps its own server even when another one is focused.
  const voice = $derived(workspace.activeVoice);
  const view = $derived(voice?.view ?? workspace.view);
  const origin = $derived(voice?.origin ?? workspace.serverOrigin);
  const snapshot = $derived(view.snapshot);
  const pending = $derived(workspace.pending);
  const ownMember = $derived(snapshot?.members.find((member) => member.connectionId === snapshot?.connectionId));
  const canSetAfk = $derived(workspace.canSetVoicePresence("afk"));

  let afkFormOpen = $state(false);
  let afkMessage = $state("");
  let afkFormOrigin = $state("");

  function showAfkForm() {
    workspace.actionError = "";
    afkFormOrigin = origin;
    afkMessage = ownMember?.afkMessage ?? "";
    afkFormOpen = true;
  }

  async function saveAfkMessage(event: SubmitEvent) {
    event.preventDefault();
    if (!canSetAfk || afkFormOrigin !== origin) return;
    if (await workspace.setVoicePresence("afk", true, afkMessage.trim())) {
      afkFormOpen = false;
    }
  }
</script>

<div class="voice-toolbar" role="group" aria-label="Voice controls">
  <div class="voice-split" role="group" aria-label="Microphone">
    <IconButton label={ownMember?.muted ? "Unmute microphone" : "Mute microphone"}
      disabled={!workspace.canSetVoicePresence("muted")}
      active={Boolean(ownMember?.muted || ownMember?.adminMuted)}
      onclick={() => workspace.setVoicePresence("muted")}>
      {#if ownMember?.muted || ownMember?.adminMuted}<MicOff size={18} aria-hidden="true" />{:else}<Mic size={18} aria-hidden="true" />{/if}
    </IconButton>
    <QuickAudio direction="input" />
  </div>
  {#if audio.talking}<span class="text-xs font-medium text-[var(--success)]" role="status">Transmitting</span>{/if}
  <div class="voice-split" role="group" aria-label="Playback">
    <IconButton label={ownMember?.adminDeafened ? "Server deafened" : ownMember?.deafened ? "Undeafen" : "Deafen"}
      disabled={!workspace.canSetVoicePresence("deafened")}
      active={Boolean(ownMember?.deafened || ownMember?.adminDeafened)}
      onclick={() => workspace.setVoicePresence("deafened")}>
      {#if ownMember?.deafened || ownMember?.adminDeafened}<HeadphoneOff size={18} aria-hidden="true" />{:else}<Headphones size={18} aria-hidden="true" />{/if}
    </IconButton>
    <QuickAudio direction="output" />
  </div>
  {#if speakerphone.available() && voice}
    <IconButton label="Speaker"
      active={speakerphone.on} onclick={() => speakerphone.toggle()}>
      <Speaker size={18} aria-hidden="true" />
    </IconButton>
  {/if}
  {#if onleave}
    <IconButton label="Leave voice" disabled={Boolean(pending)} onclick={onleave}>
      <PhoneOff size={18} aria-hidden="true" />
    </IconButton>
  {/if}
  <div class="voice-afk" role="group" aria-label="AFK">
    <Button variant="outline" type="button" class="afk-main" disabled={!canSetAfk}
      aria-pressed={Boolean(ownMember?.afk)} title={ownMember?.afk ? "Return from AFK" : "Mark as AFK"}
      onclick={() => workspace.setVoicePresence("afk")}>
      {ownMember?.afk ? "AFK (away)" : "AFK"}
    </Button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger disabled={!canSetAfk} aria-label="AFK options" class="afk-menu {buttonVariants({ variant: "outline", size: "icon" })}">
        <ChevronDown aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start">
        <DropdownMenu.Item onSelect={showAfkForm}>Set AFK message</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
  {#if desktopApp() && snapshot?.whispers}
    <WhisperControls />
  {/if}
</div>

<Modal bind:open={afkFormOpen} title="AFK message" description="People who can see your voice channel can read this message while you’re AFK." dismissible={pending !== "afk"}>
  {#if workspace.actionError}<p class="form-error" role="alert">{workspace.actionError}</p>{/if}
  <form class="dialog-form" onsubmit={saveAfkMessage}>
    <label>Message <Input type="text" maxlength={120} placeholder="Optional" autofocus bind:value={afkMessage} /></label>
    <Button variant="default" type="submit" disabled={!canSetAfk || afkFormOrigin !== origin}>
      {ownMember?.afk ? "Save message" : "Go AFK"}
    </Button>
  </form>
</Modal>

<style>
  .voice-afk { display: inline-flex; flex: none; }
  .voice-afk :global(.afk-main) { border-start-end-radius: 0; border-end-end-radius: 0; }
  .voice-afk :global(.afk-menu) { margin-inline-start: -1px; border-start-start-radius: 0; border-end-start-radius: 0; }
</style>
