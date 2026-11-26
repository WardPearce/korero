<script lang="ts">
  import { BitsConfig, Portal } from "bits-ui";
  import { Monitor, MonitorUp, Square, Video, VideoOff, X } from "@lucide/svelte";
  import { onDestroy, untrack } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { call, messageFrom, nativeApp, type ScreenShare, type Snapshot } from "#lib/connection/client";
  import { chooseScreen, ScreenMedia, supportsWebRtc, type MediaRequest, type VideoSource } from "#lib/media/screen-media";

  let { snapshot, visible, controlsTarget, source = "screen", initialSetup = false, relay }: {
    snapshot: Snapshot; visible: boolean; controlsTarget: HTMLElement; source?: VideoSource;
    initialSetup?: boolean; relay?: MediaRequest;
  } = $props();
  let setupOpen = $state(untrack(() => initialSetup));
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
  const useBrowser = !supportsWebRtc() && nativeApp() && typeof navigator !== "undefined" &&
    /Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent);
  const canCapture = $derived(typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.[camera ? "getUserMedia" : "getDisplayMedia"] === "function");
  const availableShares = $derived(camera ? snapshot.cameras : snapshot.screens);
  const browserShare = $derived(useBrowser ? availableShares?.find(({ connectionId }) => connectionId === snapshot.connectionId) : undefined);
  const sharing = $derived(Boolean(outgoingId || browserShare));
  const member = $derived(snapshot.members.find(({ connectionId }) => connectionId === snapshot.connectionId));
  const canReceive = $derived(!member?.deafened && !member?.adminDeafened && !member?.afk);
  const canShare = $derived(canReceive && (camera ? snapshot.canUseCamera ?? snapshot.canShareScreen : snapshot.canShareScreen) !== false && !member?.adminMuted);
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
    return new ScreenMedia(snapshot.connectionId, snapshot.channelId!, failed, source, relay);
  }

  function releaseCapture() {
    capture?.getTracks().forEach((track) => track.stop());
    capture = undefined;
  }

  function openSetup() {
    if (useBrowser) {
      void openBrowser(true);
      return;
    }
    if (!supportsWebRtc()) {
      error = "This browser does not support WebRTC. Open VNX.chat in a browser with WebRTC support.";
      return;
    }
    setupError = "";
    setupOpen = true;
  }

  async function openBrowser(share: boolean) {
    error = "";
    try {
      await call("open_browser_media", { connectionId: snapshot.connectionId, channelId: snapshot.channelId, source, share });
    } catch (failure) {
      error = messageFrom(failure);
    }
  }

  async function toggleSharing() {
    if (outgoingId) {
      await stopSharing();
    } else if (browserShare) {
      error = "";
      try {
        await call("screen_request", {
          connectionId: snapshot.connectionId, channelId: snapshot.channelId,
          kind: "media.producer.close", payload: { producerId: browserShare.producerId },
        });
      } catch (failure) {
        error = messageFrom(failure);
      }
    } else {
      openSetup();
    }
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
    if (useBrowser) {
      await openBrowser(false);
      return;
    }
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

{#if visible && (shares.length || watched || (outgoingId && capture) || watchedId || error)}
  <section class="screen-sharing" aria-label={camera ? "Camera video" : "Screen sharing"}>
    {#if shares.length}
      <div class="screen-actions">
        {#each shares as share (share.producerId)}
          <Button variant={watchedId === share.producerId ? "default" : "outline"} disabled={!canReceive || stoppingWatch}
            onclick={() => watchedId === share.producerId ? stopWatching() : watch(share)}>
            {#if watchedId === share.producerId}<X size={15} /> Stop watching
            {:else}<WatchIcon size={15} /> Watch {presenter(share.connectionId)}{camera ? "’s camera" : ""}{/if}
          </Button>
        {/each}
      </div>
    {/if}
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
{/if}

<Portal to={controlsTarget}>
  {#if sharing || (visible && (canCapture || useBrowser))}
    <Button variant={sharing ? "secondary" : "outline"} aria-pressed={sharing}
      title={sharing ? (camera ? "Turn off camera" : "Stop sharing") :
        useBrowser ? (camera ? "Open camera in browser" : "Open screenshare in browser") : (camera ? "Turn on camera" : "Share screen")}
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
  .screen-actions, .screen-sharing p { padding: 8px var(--ui-gap); }
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
