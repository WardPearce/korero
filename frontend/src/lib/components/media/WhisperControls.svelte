<script lang="ts">
  import { Radio } from "@lucide/svelte";
  import { onDestroy, onMount, untrack } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { getAudioSettings } from "#lib/media/audio.svelte";
  import { call, messageFrom } from "#lib/connection/client";
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
  let lease: ReturnType<typeof setInterval> | undefined;
  let acknowledged = false;
  const snapshot = $derived(workspace.view.snapshot);
  const ownMember = $derived(snapshot?.members.find((member) => member.connectionId === snapshot?.connectionId));
  const channels = $derived(snapshot?.channels.filter((channel) => channel.canWhisperTo) ?? []);
  const target = $derived(channels.find((channel) => channel.id === targetId));
  const canTalk = $derived(workspace.view.phase === "online" && workspace.view.voice === "active" &&
    Boolean(snapshot?.channelId) && !ownMember?.muted && !ownMember?.deafened && !ownMember?.adminMuted &&
    !ownMember?.adminDeafened && !ownMember?.afk);
  const activeTarget = $derived(workspace.view.whisperChannelId);
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

  function stopLease() {
    clearInterval(lease);
    lease = undefined;
    void call("whisper_to_talk", { pressed: false }).catch(() => {});
  }

  async function routeVoice() {
    if (busy) return;
    busy = true;
    try {
      while (wanted !== routed) {
        const next = wanted;
        if (next) {
          try {
            await call("whisper_to_talk", { pressed: true });
            if (wanted !== next) {
              stopLease();
              continue;
            }
            lease = setInterval(() => {
              void call("whisper_to_talk", { pressed: true }).catch(stop);
            }, 200);
            await call("set_whisper", { ...next, password: next.password ?? null });
            routed = next;
          } catch (failure) {
            error = messageFrom(failure);
            wanted = null;
            stopLease();
          }
        } else if (routed) {
          const { connectionId, channelId } = routed;
          routed = null;
          acknowledged = false;
          try {
            await call("set_whisper", { connectionId, channelId, targetId: null, password: null });
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
    stopLease();
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
  <div class="whisper-fields">
    <label>Target channel
      <select value={targetId} disabled={busy || Boolean(wanted)} onchange={(event) => setTarget(event.currentTarget.value)}>
        <option value="">Choose a channel</option>
        {#each channels as channel (channel.id)}
          <option value={channel.id}>{channel.name}{snapshot?.channelMembers?.[channel.id]?.length ? "" : " (empty)"}</option>
        {/each}
      </select>
    </label>
    {#if target?.passwordRequired}
      <label>Channel password
        <Input type="password" bind:value={password} maxlength={128} disabled={busy || Boolean(wanted)} />
      </label>
    {/if}
    <label>Activation
      <select bind:value={mode} disabled={busy || Boolean(wanted)} onchange={saveSettings}>
        <option value="hold">Push-to-talk</option>
        <option value="toggle">Toggle-to-talk</option>
      </select>
    </label>
    <TalkKey label="Whisper shortcut" {shortcut} disabled={busy || Boolean(wanted)}
      onchange={(value) => { shortcut = value; saveSettings(); }} />
    <p class="field-hint">
      {mode === "hold" ? "Hold" : "Press"} <kbd>{talkShortcutLabel(shortcut)}</kbd> while VNX.chat is focused.
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
  </div>
</Modal>

<style>
  .whisper-fields { display: grid; gap: .75rem; }
  .whisper-fields label { display: grid; gap: .35rem; }
  .whisper-fields select {
    background: var(--background);
    border: 1px solid var(--input);
    border-radius: var(--radius);
    min-height: var(--control-height);
    padding-inline: .6rem;
  }
  .whisper-status { flex: 1 0 100%; font-size: .8rem; color: var(--muted-foreground); overflow-wrap: anywhere; }
</style>
