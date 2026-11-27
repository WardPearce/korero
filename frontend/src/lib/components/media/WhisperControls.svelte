<script lang="ts">
  import { Radio } from "@lucide/svelte";
  import { onDestroy, onMount, untrack } from "svelte";
  import { BitsConfig } from "bits-ui";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import { getAudioSettings } from "#lib/media/audio.svelte";
  import { messageFrom } from "#lib/connection/client";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { preferences } from "#lib/preferences";
  import TalkKey from "./TalkKey.svelte";
  import { isTypingTalkShortcut, matchesTalkShortcut, releasesTalkShortcut, talkShortcutLabel, type TalkShortcut } from "#lib/media/talk-shortcut";
  import { getWorkspace } from "#lib/workspace";

  interface Route {
    connectionId: string;
    channelId: string;
    targetId: string;
    password?: string;
  }

  const workspace = getWorkspace();
  const audio = getAudioSettings();
  const initialShortcut: TalkShortcut = { code: "KeyB", alt: true, shift: false, ctrl: false, meta: false };
  let shortcut = $state.raw(initialShortcut);
  let mode = $state<"hold" | "toggle">("hold");
  let open = $state(false);
  let targetId = $state("");
  let password = $state("");
  let error = $state("");
  let wanted = $state.raw<Route | null>(null);
  let busy = $state(false);
  let routed: Route | null = null;
  let acknowledged = false;
  let fields = $state<HTMLElement>();
  const view = $derived(workspace.activeVoice?.view ?? workspace.view);
  const snapshot = $derived(view.snapshot);
  const ownMember = $derived(snapshot?.members.find((member) => member.connectionId === snapshot?.connectionId));
  const channels = $derived(snapshot?.channels.filter((channel) => channel.canWhisperTo) ?? []);
  const target = $derived(channels.find((channel) => channel.id === targetId));
  const canTalk = $derived(view.phase === "online" && view.voice === "active" &&
    Boolean(snapshot?.channelId) && !ownMember?.muted && !ownMember?.deafened && !ownMember?.adminMuted &&
    !ownMember?.adminDeafened && !ownMember?.afk);
  const activeTarget = $derived(view.whisperChannelId);
  const channelOptions = $derived([
    { value: "", label: "Choose a channel" },
    ...channels.map((channel) => ({
      value: channel.id,
      label: `${channel.name}${snapshot?.channelMembers?.[channel.id]?.length ? "" : " (empty)"}`
    }))
  ]);
  const modeOptions = [
    { value: "hold", label: "Push-to-talk" },
    { value: "toggle", label: "Toggle-to-talk" }
  ] as const;
  const canStart = $derived(canTalk && Boolean(target && snapshot?.channelMembers?.[target.id]?.length &&
    (!target.passwordRequired || password)));
  const incoming = $derived(snapshot?.whispers ?? []);

  onMount(async () => {
    const saved = await preferences.local.get("whisper").catch(() => undefined);
    const setting = saved?.value as { mode?: "hold" | "toggle"; shortcut?: TalkShortcut } | undefined;
    if (setting?.mode === "toggle") mode = setting.mode;
    if (setting?.shortcut?.code) shortcut = setting.shortcut;
  });

  function saveSettings() {
    void preferences.local.put({ key: "whisper", value: { mode, shortcut } })
      .catch((failure) => { error = messageFrom(failure); });
  }

  function setTarget(id: string) {
    targetId = id;
    password = "";
    error = "";
  }

  function setMode(next: "hold" | "toggle") {
    mode = next;
    saveSettings();
  }

  async function routeVoice() {
    if (busy) return;
    busy = true;
    try {
      while (wanted !== routed) {
        const next = wanted;
        if (next) {
          try {
            audio.voice.setWhisperTalking(true);
            await audio.voice.setWhisper(next.connectionId, next.channelId, next.targetId, next.password);
            routed = next;
          } catch (failure) {
            error = messageFrom(failure);
            wanted = null;
            audio.voice.setWhisperTalking(false);
          }
        } else if (routed) {
          const { connectionId, channelId } = routed;
          routed = null;
          acknowledged = false;
          try {
            await audio.voice.setWhisper(connectionId, channelId);
          } catch (failure) {
            if (snapshot?.connectionId === connectionId && snapshot.channelId === channelId) error = messageFrom(failure);
          }
        }
      }
    } finally {
      busy = false;
    }
  }

  function start() {
    if (wanted || busy || !canStart || !target || !snapshot?.channelId) return;
    error = "";
    wanted = { connectionId: snapshot.connectionId, channelId: snapshot.channelId, targetId: target.id,
      password: target.passwordRequired ? password : undefined };
    void routeVoice();
  }

  function stop() {
    if (!wanted && !routed && !busy) return;
    wanted = null;
    audio.voice.setWhisperTalking(false);
    void routeVoice();
  }

  function toggle() {
    if (wanted) stop();
    else start();
  }

  function keyDown(event: KeyboardEvent) {
    if (event.repeat || event.defaultPrevented || !matchesTalkShortcut(event, shortcut) || isTypingTalkShortcut(event, shortcut)) return;
    if (["pushToTalk", "toggleToTalk"].includes(audio.profile.transmitMode) && matchesTalkShortcut(event, audio.profile.talkShortcut)) {
      error = "Choose a whisper shortcut different from the microphone shortcut.";
      return;
    }
    if (!wanted && !canStart) return;
    event.preventDefault();
    if (mode === "toggle") toggle();
    else start();
  }

  function keyUp(event: KeyboardEvent) {
    if (mode === "hold" && releasesTalkShortcut(event, shortcut)) stop();
  }

  function pointerDown(event: PointerEvent) {
    if (mode !== "hold" || event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    start();
  }

  function buttonKey(event: KeyboardEvent, down: boolean) {
    if (mode !== "hold" || (event.code !== "Space" && event.code !== "Enter")) return;
    event.preventDefault();
    if (!down) stop();
    else if (!event.repeat) start();
  }

  function endHold() {
    if (mode === "hold") stop();
  }

  $effect(() => {
    if (!wanted) return;
    if (activeTarget === wanted.targetId) acknowledged = true;
    if (!canTalk || snapshot?.connectionId !== wanted.connectionId || snapshot.channelId !== wanted.channelId ||
        (acknowledged && !busy && !activeTarget)) untrack(stop);
  });

  onDestroy(stop);
</script>

<svelte:window onkeydown={keyDown} onkeyup={keyUp} onblur={stop} />

<IconButton label={activeTarget ? `Whispering to ${target?.name ?? "channel"}` : "Whisper to another channel"}
  active={Boolean(activeTarget)} disabled={!canTalk && !activeTarget} onclick={() => { open = true; }}>
  <Radio size={18} aria-hidden="true" />
</IconButton>

{#if incoming.length}
  <span class="whisper-status" role="status">Whisper from {incoming.map(({ from }) => from).join(", ")}</span>
{/if}
{#if activeTarget && target}
  <span class="whisper-status" role="status">Whispering to {target.name}</span>
{/if}
{#if error && !open}
  <span class="whisper-status" role="alert">{error}</span>
{/if}

<Modal bind:open title="Channel whisper" description="Speak to people in another channel while staying in your current channel.">
  <div class="whisper-fields" bind:this={fields}>
    {#if fields}
      <BitsConfig defaultPortalTo={fields}>
        <SelectField label="Target channel" options={channelOptions} placeholder="Choose a channel"
          disabled={busy || Boolean(wanted)} bind:value={() => targetId, setTarget} />
        {#if target?.passwordRequired}
          <label>Channel password
            <Input type="password" bind:value={password} maxlength={128} disabled={busy || Boolean(wanted)} />
          </label>
        {/if}
        <SelectField label="Activation" options={modeOptions}
          disabled={busy || Boolean(wanted)} bind:value={() => mode, setMode} />
        <TalkKey label="Whisper shortcut" {shortcut} disabled={busy || Boolean(wanted)}
          onchange={(value) => { shortcut = value; saveSettings(); }} />
        <p class="field-hint">
          {mode === "hold" ? "Hold" : "Press"} <kbd>{talkShortcutLabel(shortcut)}</kbd> while Korero.chat is focused.
        </p>
        {#if error}<p class="notice" role="alert">{error}</p>{/if}
        <div class="dialog-actions">
          <Button variant={wanted ? "destructive" : "default"} disabled={!wanted && (busy || !canStart)}
            onpointerdown={pointerDown} onpointerup={endHold} onpointercancel={endHold} onlostpointercapture={endHold}
            onkeydown={(event) => buttonKey(event, true)} onkeyup={(event) => buttonKey(event, false)}
            onclick={() => { if (mode === "toggle") toggle(); }}>
            {busy ? (wanted ? "Connecting…" : "Stopping…")
              : mode === "toggle" ? (wanted ? "Stop whisper" : "Start whisper") : (wanted ? "Whispering…" : "Hold to whisper")}
          </Button>
        </div>
      </BitsConfig>
    {/if}
  </div>
</Modal>

<style>
  .whisper-fields { display: grid; gap: .75rem; }
  .whisper-fields label { display: grid; gap: .35rem; }
  .whisper-status { flex: 1 0 100%; font-size: .8rem; color: var(--muted-foreground); overflow-wrap: anywhere; }
</style>
