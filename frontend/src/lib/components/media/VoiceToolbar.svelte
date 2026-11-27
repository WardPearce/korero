<script lang="ts">
  import { ChevronDown, HeadphoneOff, Headphones, Mic, MicOff } from "@lucide/svelte";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { desktopApp } from "#lib/connection/client";
  import { voiceApp } from "#lib/connection/platform";
  import { getAudioSettings } from "#lib/media/audio.svelte";
  import { playUiSound } from "#lib/ui-sounds";
  import { getWorkspace } from "#lib/workspace";
  import QuickAudio from "./QuickAudio.svelte";
  import WhisperControls from "./WhisperControls.svelte";

  const workspace = getWorkspace();
  const audio = getAudioSettings();
  const voiceAvailable = voiceApp();
  // A voice session keeps its own server even when another one is focused.
  const voice = $derived(workspace.activeVoice);
  const view = $derived(voice?.view ?? workspace.view);
  const origin = $derived(voice?.origin ?? workspace.serverOrigin);
  const snapshot = $derived(view.snapshot);
  const pending = $derived(workspace.pending);
  const online = $derived(view.phase === "online");
  const ownMember = $derived(snapshot?.members.find((member) => member.connectionId === snapshot?.connectionId));
  const activeChannel = $derived(snapshot?.channels.find((channel) => channel.id === snapshot?.channelId));
  const canVoice = $derived(voiceAvailable && online && Boolean(activeChannel));
  const canSetAfk = $derived(canVoice && ownMember?.afk !== undefined && !pending);

  let afkFormOpen = $state(false);
  let afkMessage = $state("");
  let afkFormOrigin = $state("");

  async function toggleAfk() {
    if (!canSetAfk) return;
    const markingAfk = !ownMember?.afk;
    if (await workspace.runVoice("afk", "set_presence", { afk: markingAfk, afkMessage: "" })) playUiSound(markingAfk ? "afk" : "back");
  }

  function showAfkForm() {
    workspace.actionError = "";
    afkFormOrigin = origin;
    afkMessage = ownMember?.afkMessage ?? "";
    afkFormOpen = true;
  }

  async function saveAfkMessage(event: SubmitEvent) {
    event.preventDefault();
    if (!canSetAfk || afkFormOrigin !== origin) return;
    const wasAfk = Boolean(ownMember?.afk);
    if (await workspace.runVoice("afk", "set_presence", { afk: true, afkMessage: afkMessage.trim() })) {
      if (!wasAfk) playUiSound("afk");
      afkFormOpen = false;
    }
  }
</script>

<div class="voice-toolbar" role="group" aria-label="Voice controls">
  <div class="voice-split" role="group" aria-label="Microphone">
    <IconButton label={ownMember?.muted ? "Unmute microphone" : "Mute microphone"}
      disabled={!canVoice || Boolean(pending) || ownMember?.adminMuted || ownMember?.afk}
      active={Boolean(ownMember?.muted || ownMember?.adminMuted)}
      onclick={async () => { const muting = !ownMember?.muted; if (await workspace.runVoice("mute", "set_presence", { muted: muting, deafened: null })) playUiSound(muting ? "mute" : "unmute"); }}>
      {#if ownMember?.muted || ownMember?.adminMuted}<MicOff size={18} aria-hidden="true" />{:else}<Mic size={18} aria-hidden="true" />{/if}
    </IconButton>
    <QuickAudio direction="input" />
  </div>
  {#if audio.talking}<span class="text-xs font-medium text-[var(--success)]" role="status">Transmitting</span>{/if}
  <div class="voice-split" role="group" aria-label="Playback">
    <IconButton label={ownMember?.adminDeafened ? "Server deafened" : ownMember?.deafened ? "Undeafen" : "Deafen"}
      disabled={!canVoice || Boolean(pending) || ownMember?.afk || ownMember?.adminDeafened}
      active={Boolean(ownMember?.deafened || ownMember?.adminDeafened)}
      onclick={async () => { const deafening = !ownMember?.deafened; if (await workspace.runVoice("deafen", "set_presence", { muted: null, deafened: deafening })) playUiSound(deafening ? "deafen" : "undeafen"); }}>
      {#if ownMember?.deafened || ownMember?.adminDeafened}<HeadphoneOff size={18} aria-hidden="true" />{:else}<Headphones size={18} aria-hidden="true" />{/if}
    </IconButton>
    <QuickAudio direction="output" />
  </div>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger disabled={!canSetAfk} class={buttonVariants({ variant: "outline" })}>
      {ownMember?.afk ? "AFK (away)" : "AFK"} <ChevronDown aria-hidden="true" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start">
      <DropdownMenu.Item onSelect={toggleAfk}>{ownMember?.afk ? "Return from AFK" : "Mark as AFK"}</DropdownMenu.Item>
      <DropdownMenu.Item onSelect={showAfkForm}>Set AFK message</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
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
