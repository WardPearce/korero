<script lang="ts">
  import { BitsConfig, Portal } from "bits-ui";
  import { ExternalLink, Grip, Monitor, MonitorUp, PanelTop, Play, Square, Video, VideoOff, X } from "@lucide/svelte";
  import { onDestroy, tick, untrack } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { messageFrom, type ScreenShare, type Snapshot } from "#lib/connection/client";
  import { chooseScreen, ScreenMedia, supportsWebRtc, type VideoSource } from "#lib/media/screen-media";

  let { snapshot, visible, controlsTarget, inlineTarget, onDock, source = "screen" }: {
    snapshot: Snapshot; visible: boolean; controlsTarget: HTMLElement; source?: VideoSource;
    inlineTarget?: HTMLElement; onDock?: () => void;
  } = $props();
  let setupOpen = $state(false);
  let setupForm = $state<HTMLFormElement>();
  let choosing = $state(false);
  let publishing = $state(false);
  let capture = $state<MediaStream>();
  let outgoing = $state<ScreenMedia>();
  let outgoingId = $state("");
  let wasPublished = false;
  let incoming = $state<ScreenMedia>();
  let watched = $state<MediaStream>();
  let watchedId = $state("");
  let poppedOut = $state(false);
  let floatingPlayer = $state<HTMLElement>();
  let playerToggle = $state<HTMLElement | null>(null);
  let playerPosition = $state<{ x: number; y: number }>();
  let drag: { id: number; offsetX: number; offsetY: number } | undefined;
  let streamMuted = $state(true);
  let streamVolume = $state(1);
  let stoppingShare = $state(false);
  let stoppingWatch = $state(false);
  let error = $state("");
  let setupError = $state("");
  let resolution = $state(untrack(() => source === "camera" ? "720" : "1080"));
  let frameRate = $state("30");
  let videoKbps = $state<number | undefined>(untrack(() => source === "camera" ? 2000 : 6000));
  let shareAudio = $state(false);
  let audioKbps = $state("128");
  let sourceHasAudio = $state(false);
  let requestedAudio = $state(false);
  let destroyed = false;

  const camera = $derived(source === "camera");
  const CaptureIcon = $derived(camera ? Video : MonitorUp);
  const WatchIcon = $derived(camera ? Video : Monitor);
  const StopIcon = $derived(camera ? VideoOff : Square);
  const title = $derived(camera ? "Camera" : "Share screen");
  const cameraResolutions = [360, 480, 720, 1080].map((height) => ({ value: String(height), label: `${height}p` }));
  const screenResolutions = [{ value: "0", label: "Source" }, ...cameraResolutions, { value: "1440", label: "1440p" }];
  const frameRates = [5, 15, 30, 60].map((fps) => ({ value: String(fps), label: `${fps} FPS` }));
  const audioBitrates = [64, 96, 128, 192, 256, 320].map((bitrate) => ({ value: String(bitrate), label: String(bitrate) }));
  const canCapture = $derived(typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.[camera ? "getUserMedia" : "getDisplayMedia"] === "function");
  const availableShares = $derived(camera ? snapshot.cameras : snapshot.screens);
  const sharing = $derived(Boolean(outgoingId));
  const member = $derived(snapshot.members.find(({ connectionId }) => connectionId === snapshot.connectionId));
  const canReceive = $derived(!member?.deafened && !member?.adminDeafened && !member?.afk);
  const canShare = $derived(canReceive && (camera ? snapshot.canUseCamera ?? snapshot.canShareScreen : snapshot.canShareScreen) !== false && !member?.adminMuted);
  const shares = $derived((availableShares ?? []).filter(({ connectionId }) => connectionId !== snapshot.connectionId));
  const watchedShare = $derived(shares.find(({ producerId }) => producerId === watchedId));
  const floating = $derived(!camera && Boolean(watched && watchedShare) && (poppedOut || !visible));

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
    if (!supportsWebRtc()) {
      error = "This browser does not support WebRTC. Open Korero.chat in a browser with WebRTC support.";
      return;
    }
    setupError = "";
    setupOpen = true;
  }

  async function toggleSharing() {
    if (outgoingId) await stopSharing();
    else openSetup();
  }

  async function selectSource() {
    if (choosing || publishing || !canShare) return;
    choosing = true;
    setupError = "";
    const audio = shareAudio;
    try {
      const stream = camera ? await navigator.mediaDevices.getUserMedia({
        video: { height: { ideal: Number(resolution) || 720 }, frameRate: { ideal: Number(frameRate) } }, audio: false,
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
        resolution: Number(resolution) || null, frameRate: Number(frameRate), videoBitrate: videoKbps * 1000,
        audio: shareAudio, audioBitrate: Number(audioKbps) * 1000,
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
    poppedOut = false;
    drag = undefined;
    streamMuted = true;
    streamVolume = 1;
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

  async function togglePopout() {
    if (floating) {
      onDock?.();
      poppedOut = false;
    } else {
      poppedOut = true;
    }
    await tick();
    playerToggle?.focus();
  }

  function positionPlayer(x: number, y: number) {
    if (!floatingPlayer) return;
    const margin = 8;
    playerPosition = {
      x: Math.max(margin, Math.min(x, document.documentElement.clientWidth - floatingPlayer.offsetWidth - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - floatingPlayer.offsetHeight - margin)),
    };
  }

  function keepPlayerInView() {
    if (floating && playerPosition) positionPlayer(playerPosition.x, playerPosition.y);
  }

  function startDrag(event: PointerEvent) {
    if (event.button !== 0 || drag || !floatingPlayer || !(event.currentTarget instanceof HTMLElement)) return;
    const bounds = floatingPlayer.getBoundingClientRect();
    drag = { id: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent) {
    if (drag?.id === event.pointerId) positionPlayer(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
  }

  function finishDrag(event: PointerEvent) {
    if (drag?.id === event.pointerId) drag = undefined;
  }

  function moveWithKeyboard(event: KeyboardEvent) {
    if (!floatingPlayer) return;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!Object.hasOwn(directions, event.key)) return;
    event.preventDefault();
    const [x, y] = directions[event.key as keyof typeof directions];
    const bounds = floatingPlayer.getBoundingClientRect();
    positionPlayer(bounds.left + x * 24, bounds.top + y * 24);
  }
</script>

<svelte:window onresize={keepPlayerInView} />

{#snippet screenPlayer(stream: MediaStream, share: ScreenShare, detached: boolean)}
  <header class="player-bar">
    {#if detached}
      <Button size="icon-sm" variant="ghost" class="drag-handle" aria-label="Move stream with arrow keys"
        title="Drag to move stream" onpointerdown={startDrag} onpointermove={moveDrag}
        onlostpointercapture={finishDrag} onkeydown={moveWithKeyboard}>
        <Grip aria-hidden="true" />
      </Button>
    {/if}
    <span class="live-dot" aria-hidden="true"></span>
    <span class="player-name truncate" title={presenter(share.connectionId)}>{presenter(share.connectionId)}’s screen</span>
    <Button size={detached ? "icon-sm" : "sm"} variant="outline" bind:ref={playerToggle} onclick={togglePopout}
      aria-label={detached ? "Dock stream" : "Pop out stream"} title={detached ? "Dock stream" : "Pop out stream"}>
      {#if detached}<PanelTop aria-hidden="true" />
      {:else}<ExternalLink aria-hidden="true" /> Pop out{/if}
    </Button>
    {#if detached}
      <Button size="icon-sm" variant="ghost" aria-label="Stop watching" title="Stop watching" onclick={stopWatching}>
        <X aria-hidden="true" />
      </Button>
    {/if}
  </header>
  <video autoplay playsinline controls aria-label="Shared screen"
    bind:muted={streamMuted} bind:volume={streamVolume} {@attach (element) => showPreview(element, stream)}></video>
{/snippet}

{#if visible && (shares.length || watched || (outgoingId && capture) || watchedId || error)}
  <Portal to={inlineTarget} disabled={!inlineTarget}>
    <section class="screen-sharing" aria-label={camera ? "Camera video" : "Screen sharing"}>
      {#if shares.length}
        <div class="screen-actions">
          {#each shares as share (share.producerId)}
            {@const watching = watchedId === share.producerId}
            {#if camera}
              <Button variant={watching ? "default" : "outline"} disabled={!canReceive || stoppingWatch}
                onclick={() => watching ? stopWatching() : watch(share)}>
                {#if watching}<X size={15} /> Stop watching
                {:else}<WatchIcon size={15} /> Watch {presenter(share.connectionId)}’s camera{/if}
              </Button>
            {:else}
              <div class="live-share">
                <span class="live-label"><span class="live-dot" aria-hidden="true"></span> Live</span>
                <span class="truncate" title={presenter(share.connectionId)}>{presenter(share.connectionId)} is sharing their screen</span>
                <Button variant={watching ? "outline" : "default"} class="ms-auto" disabled={!canReceive || stoppingWatch}
                  aria-label={watching ? `Stop watching ${presenter(share.connectionId)}` : `Watch live stream from ${presenter(share.connectionId)}`}
                  onclick={() => watching ? stopWatching() : watch(share)}>
                  {#if watching}<X size={15} aria-hidden="true" /> Stop watching
                  {:else}<Play size={15} aria-hidden="true" /> Watch live stream{/if}
                </Button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      {#if watched && watchedShare && !camera}
        {#if !floating}{@render screenPlayer(watched, watchedShare, false)}{/if}
      {:else if (watched && camera) || (outgoingId && capture)}
        {@const stream = watched ?? capture!}
        <video autoplay muted playsinline
          aria-label={camera ? (watched ? "Shared camera" : "Your camera preview") : "Your screen preview"}
          {@attach (element) => showPreview(element, stream)}></video>
      {:else if watchedId}
        <p role="status">{camera ? "Opening camera…" : "Opening screen share…"}</p>
      {/if}
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    </section>
  </Portal>
{/if}

{#if floating && watched && watchedShare}
  <Portal to="body">
    <section class="floating-player" aria-label="Floating live stream" bind:this={floatingPlayer}
      data-positioned={playerPosition ? "" : undefined}
      style:left={playerPosition ? playerPosition.x + "px" : undefined}
      style:top={playerPosition ? playerPosition.y + "px" : undefined}
      {@attach () => untrack(keepPlayerInView)}>
      {@render screenPlayer(watched, watchedShare, true)}
    </section>
  </Portal>
{/if}

<Portal to={controlsTarget}>
  {#if sharing || (visible && canCapture)}
    <Button variant={sharing ? "secondary" : "outline"} aria-pressed={sharing}
      title={sharing ? (camera ? "Turn off camera" : "Stop sharing") :
        (camera ? "Turn on camera" : "Share screen")}
      onclick={toggleSharing} disabled={!sharing && (!canShare || stoppingShare)}>
      {#if sharing}<StopIcon size={15} aria-hidden="true" />{:else}<CaptureIcon size={15} aria-hidden="true" />{/if}
      {camera ? "Camera" : "Screenshare"}
    </Button>
  {/if}

  <Modal bind:open={setupOpen} {title} description={camera ? "Preview your camera and choose the quality before sharing video with this channel."
    : "Choose a window, tab, or entire display to share with this channel."}
    dismissible={!publishing}>
    <form class="dialog-form" bind:this={setupForm} onsubmit={startSharing}>
      {#if capture}
        <video autoplay muted playsinline aria-label="Source preview" {@attach (element) => showPreview(element, capture!)}></video>
      {/if}
      {#if !camera || !capture}
        <Button type="button" variant="outline" onclick={selectSource} disabled={choosing || publishing}>
          <WatchIcon size={16} /> {camera ? (choosing ? "Opening camera…" : "Preview camera")
            : (choosing ? "Opening source picker…" : capture ? "Change source" : "Choose source")}
        </Button>
      {/if}
      {#if setupForm}
        <BitsConfig defaultPortalTo={setupForm}>
          <div class="capture-fields">
            <SelectField label="Resolution" options={camera ? cameraResolutions : screenResolutions} bind:value={resolution} disabled={publishing} />
            <SelectField label="Frame rate" options={frameRates} bind:value={frameRate} disabled={publishing} />
            <label>Video bitrate (kbps)
              <Input type="number" required min={camera ? 200 : 500} max={camera ? 6000 : 12000} step={100} bind:value={videoKbps} disabled={publishing} />
            </label>
            {#if shareAudio}
              <SelectField label="Audio bitrate (kbps)" options={audioBitrates} bind:value={audioKbps} disabled={publishing} />
            {/if}
          </div>
        </BitsConfig>
      {/if}
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
</Portal>

<style>
  .screen-sharing { border-bottom: 1px solid var(--border); }
  .screen-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .screen-actions:has(.live-share) { max-height: 26dvh; overflow-y: auto; }
  .screen-actions, .screen-sharing p { padding: 8px var(--ui-gap); }
  .live-share, .player-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--card);
  }
  .live-share {
    width: 100%;
    flex-wrap: wrap;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .live-label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--destructive) 14%, transparent);
    color: var(--destructive);
    font-size: var(--type-caption);
    font-weight: 700;
    text-transform: uppercase;
  }
  .live-dot { flex: none; width: .45rem; height: .45rem; border-radius: 50%; background: var(--destructive); }
  .player-bar { padding-inline: var(--ui-gap); }
  .player-name { flex: 1; min-width: 0; font-size: var(--type-small); font-weight: 600; }
  .floating-player {
    position: fixed;
    z-index: 40;
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom));
    width: min(32rem, calc(100% - 24px));
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    box-shadow: var(--shadow-floating);
  }
  .floating-player[data-positioned] { right: auto; bottom: auto; }
  @media (max-width: 760px) {
    .floating-player:not([data-positioned]) { top: 12px; bottom: auto; }
  }
  .floating-player .player-bar { padding-inline: 6px; }
  .floating-player :global(.drag-handle) { cursor: grab; touch-action: none; }
  .floating-player :global(.drag-handle:active) { cursor: grabbing; }
  .floating-player video { aspect-ratio: 16 / 9; max-height: 50dvh; border-radius: 0; }
  video {
    display: block;
    width: 100%;
    max-height: 38dvh;
    background: #111;
    border-radius: var(--radius-md);
    object-fit: contain;
  }
  .capture-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
</style>
