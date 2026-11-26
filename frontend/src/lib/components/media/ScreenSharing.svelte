<script lang="ts">
  import { Monitor, MonitorUp, Square, Video, VideoOff, X } from "@lucide/svelte";
  import { onDestroy, untrack } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { messageFrom, type ScreenShare, type Snapshot } from "#lib/connection/client";
  import { chooseScreen, ScreenMedia, type VideoSource } from "#lib/media/screen-media";

  let { snapshot, visible, source = "screen" }: { snapshot: Snapshot; visible: boolean; source?: VideoSource } = $props();
  let setupOpen = $state(false);
  let choosing = $state(false);
  let publishing = $state(false);
  let capture = $state<MediaStream>();
  let outgoing = $state<ScreenMedia>();
  let outgoingId = $state("");
  let wasPublished = false;
  let incoming = $state<ScreenMedia>();
  let watched = $state<MediaStream>();
  let watchedId = $state("");
  let stoppingShare = $state(false);
  let stoppingWatch = $state(false);
  let error = $state("");
  let setupError = $state("");
  let resolution = $state(untrack(() => source === "camera" ? 720 : 1080));
  let frameRate = $state(30);
  let videoKbps = $state<number | undefined>(untrack(() => source === "camera" ? 2000 : 4500));
  let shareAudio = $state(false);
  let audioKbps = $state(128);
  let sourceHasAudio = $state(false);
  let requestedAudio = $state(false);
  let destroyed = false;

  const camera = $derived(source === "camera");
  const CaptureIcon = $derived(camera ? Video : MonitorUp);
  const WatchIcon = $derived(camera ? Video : Monitor);
  const StopIcon = $derived(camera ? VideoOff : Square);
  const title = $derived(camera ? "Camera" : "Share screen");
  const canCapture = $derived(typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.[camera ? "getUserMedia" : "getDisplayMedia"] === "function");
  const availableShares = $derived(camera ? snapshot.cameras : snapshot.screens);
  const member = $derived(snapshot.members.find(({ connectionId }) => connectionId === snapshot.connectionId));
  const canReceive = $derived(!member?.deafened && !member?.adminDeafened && !member?.afk);
  const canShare = $derived(canReceive && snapshot.canShareScreen !== false && !member?.adminMuted);
  const shares = $derived((availableShares ?? []).filter(({ connectionId }) => connectionId !== snapshot.connectionId));
  const watchedShare = $derived(shares.find(({ producerId }) => producerId === watchedId));

  $effect(() => {
    if (!setupOpen && !outgoing) releaseCapture();
  });

  $effect(() => {
    const published = availableShares?.some(({ connectionId }) => connectionId === snapshot.connectionId);
    if (published) wasPublished = true;
    if (!canShare || (outgoingId && wasPublished && !published)) {
      if (setupOpen) setupOpen = false;
      if (outgoing) void stopSharing();
    }
  });

  $effect(() => {
    if (!watchedId) return;
    if (!canReceive || !watchedShare) void stopWatching();
    else if (!watchedShare.audioProducerId && watched) {
      for (const track of watched.getAudioTracks()) watched.removeTrack(track);
    }
  });

  onDestroy(() => {
    destroyed = true;
    releaseCapture();
    void outgoing?.close();
    void incoming?.close();
  });

  function media(failed: (message: string) => void) {
    return new ScreenMedia(snapshot.connectionId, snapshot.channelId!, failed, source);
  }

  function releaseCapture() {
    capture?.getTracks().forEach((track) => track.stop());
    capture = undefined;
  }

  function openSetup() {
    setupError = "";
    setupOpen = true;
  }

  async function selectSource() {
    if (choosing || publishing || !canShare) return;
    choosing = true;
    setupError = "";
    const audio = shareAudio;
    try {
      const stream = camera ? await navigator.mediaDevices.getUserMedia({
        video: { height: { ideal: resolution || 720 }, frameRate: { ideal: frameRate } }, audio: false,
      }) : await chooseScreen(audio);
      if (destroyed || !setupOpen || !canShare) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      releaseCapture();
      capture = stream;
      requestedAudio = audio;
      sourceHasAudio = stream.getAudioTracks().length > 0;
      const track = stream.getVideoTracks()[0];
      track?.addEventListener("ended", () => {
        if (capture !== stream) return;
        if (outgoing) void stopSharing();
        else releaseCapture();
      }, { once: true });
    } catch (failure) {
      if (camera || !(failure instanceof DOMException && failure.name === "NotAllowedError")) setupError = messageFrom(failure);
    } finally {
      choosing = false;
    }
  }

  async function startSharing(event: SubmitEvent) {
    event.preventDefault();
    if (!canShare || !capture || outgoing || stoppingShare || videoKbps === undefined) return;
    error = "";
    setupError = "";
    publishing = true;
    wasPublished = false;
    const session = media((message) => {
      if (outgoing !== session) return;
      error = message;
      void stopSharing();
    });
    outgoing = session;
    try {
      const producerId = await session.share(capture, {
        resolution: resolution || null, frameRate, videoBitrate: videoKbps * 1000, audio: shareAudio, audioBitrate: audioKbps * 1000,
      });
      if (outgoing === session) {
        outgoingId = producerId;
        setupOpen = false;
      }
    } catch (failure) {
      if (outgoing !== session) return;
      setupError = messageFrom(failure);
      await session.close();
      if (outgoing === session) outgoing = undefined;
    } finally {
      publishing = false;
    }
  }

  async function stopSharing() {
    const session = outgoing;
    if (!session) return;
    stoppingShare = true;
    outgoing = undefined;
    outgoingId = "";
    wasPublished = false;
    releaseCapture();
    await session.close();
    stoppingShare = false;
  }

  async function watch(share: ScreenShare) {
    if (!canReceive || stoppingWatch || watchedId === share.producerId) return;
    await stopWatching();
    if (destroyed || incoming) return;
    error = "";
    const session = media((message) => {
      if (incoming !== session) return;
      error = message;
      void stopWatching();
    });
    watchedId = share.producerId;
    incoming = session;
    try {
      const stream = await session.watch(share);
      if (incoming === session) watched = stream;
    } catch (failure) {
      if (incoming !== session) return;
      error = messageFrom(failure);
      await stopWatching();
    }
  }

  async function stopWatching() {
    const session = incoming;
    if (!session) return;
    stoppingWatch = true;
    incoming = undefined;
    watched = undefined;
    watchedId = "";
    await session.close();
    stoppingWatch = false;
  }

  function presenter(connectionId: string) {
    return snapshot.members.find((member) => member.connectionId === connectionId)?.displayName ?? "Channel member";
  }

  function showPreview(element: HTMLVideoElement, stream: MediaStream) {
    element.srcObject = stream;
    return () => { element.srcObject = null; };
  }
</script>

{#if visible && (canCapture || shares.length || error)}
  <section class="screen-sharing" aria-label={camera ? "Camera video" : "Screen sharing"}>
    <div class="screen-actions">
      {#if outgoingId}
        <Button variant="outline" onclick={stopSharing}><StopIcon size={15} /> {camera ? "Turn off camera" : "Stop sharing"}</Button>
      {:else if canCapture}
        <Button variant="outline" onclick={openSetup} disabled={!canShare || stoppingShare}>
          <CaptureIcon size={15} /> {camera ? "Turn on camera" : "Share screen"}
        </Button>
      {/if}
      {#each shares as share (share.producerId)}
        <Button variant={watchedId === share.producerId ? "default" : "outline"} disabled={!canReceive || stoppingWatch}
          onclick={() => watchedId === share.producerId ? stopWatching() : watch(share)}>
          {#if watchedId === share.producerId}<X size={15} /> Stop watching
          {:else}<WatchIcon size={15} /> Watch {presenter(share.connectionId)}{camera ? "’s camera" : ""}{/if}
        </Button>
      {/each}
    </div>
    {#if watched || (outgoingId && capture)}
      {@const stream = watched ?? capture!}
      <video autoplay muted playsinline controls={Boolean(watched) && !camera}
        aria-label={camera ? (watched ? "Shared camera" : "Your camera preview") : (watched ? "Shared screen" : "Your screen preview")}
        {@attach (element) => showPreview(element, stream)}></video>
    {:else if watchedId}
      <p role="status">{camera ? "Opening camera…" : "Opening screen share…"}</p>
    {/if}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  </section>
{:else if camera && outgoingId}
  <section class="screen-sharing" aria-label="Camera video">
    <Button variant="outline" onclick={stopSharing}><VideoOff size={15} /> Turn off camera</Button>
  </section>
{/if}

<Modal bind:open={setupOpen} {title} description={camera ? "Preview your camera and choose the quality before sharing video with this channel."
  : "Choose a window, tab, or entire display to share with this channel."}
  dismissible={!publishing}>
  <form class="dialog-form" onsubmit={startSharing}>
    {#if capture}
      <video autoplay muted playsinline aria-label="Source preview" {@attach (element) => showPreview(element, capture!)}></video>
    {/if}
    {#if !camera || !capture}
      <Button type="button" variant="outline" onclick={selectSource} disabled={choosing || publishing}>
        <WatchIcon size={16} /> {camera ? (choosing ? "Opening camera…" : "Preview camera")
          : (choosing ? "Opening source picker…" : capture ? "Change source" : "Choose source")}
      </Button>
    {/if}
    <div class="capture-fields">
      <label>Resolution
        <select bind:value={resolution} disabled={publishing}>
          {#if !camera}<option value={0}>Source</option>{/if}
          {#each (camera ? [360, 480, 720, 1080] : [360, 480, 720, 1080, 1440]) as height (height)}
            <option value={height}>{height}p</option>
          {/each}
        </select>
      </label>
      <label>Frame rate
        <select bind:value={frameRate} disabled={publishing}>
          {#each [5, 15, 30, 60] as fps (fps)}<option value={fps}>{fps} FPS</option>{/each}
        </select>
      </label>
      <label>Video bitrate (kbps)
        <Input type="number" required min={camera ? 200 : 500} max={camera ? 6000 : 12000} step={100} bind:value={videoKbps} disabled={publishing} />
      </label>
      {#if shareAudio}
        <label>Audio bitrate (kbps)
          <select bind:value={audioKbps} disabled={publishing}>
            {#each [64, 96, 128, 192, 256, 320] as bitrate (bitrate)}<option value={bitrate}>{bitrate}</option>{/each}
          </select>
        </label>
      {/if}
    </div>
    {#if !camera}<Checkbox label="Share source audio" bind:checked={shareAudio} disabled={choosing || publishing} />{/if}
    {#if shareAudio && !capture}
      <p class="field-hint">Audio availability depends on the selected source and your browser or operating system.</p>
    {:else if shareAudio && capture && !requestedAudio}
      <p class="field-hint">Choose the source again to request its audio.</p>
    {:else if shareAudio && capture && !sourceHasAudio}
      <p class="field-hint">This source supplied video only. Choose a different source to include audio.</p>
    {/if}
    {#if setupError}<p class="form-error" role="alert">{setupError}</p>{/if}
    <div class="dialog-actions">
      <Button type="button" variant="outline" onclick={() => { setupOpen = false; }} disabled={publishing}>Cancel</Button>
      <Button type="submit" variant="default" disabled={!capture || choosing || publishing || (shareAudio && !requestedAudio)}>
        {publishing ? "Starting…" : camera ? "Start camera" : "Go live"}
      </Button>
    </div>
  </form>
</Modal>

<style>
  .screen-sharing { border-bottom: 1px solid var(--border); }
  .screen-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .screen-actions:not(:empty), .screen-sharing p { padding: 8px var(--ui-gap); }
  video {
    display: block;
    width: 100%;
    max-height: 38dvh;
    background: #111;
    border-radius: var(--radius-md);
    object-fit: contain;
  }
  .capture-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .capture-fields select {
    min-height: var(--control-height);
    padding: 0 10px;
    border: 1px solid var(--input);
    border-radius: var(--radius-lg);
    color: var(--foreground);
    background: var(--card);
  }
</style>
