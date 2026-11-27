<script lang="ts">
  import { BitsConfig, Portal } from "bits-ui";
  import { Monitor, MonitorUp, Square, Video, VideoOff, X } from "@lucide/svelte";
  import { onDestroy, onMount, untrack } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import ScreenShareViewer from "./ScreenShareViewer.svelte";
  import { messageFrom, type ScreenShare, type Snapshot } from "#lib/connection/client";
  import { chooseScreen, ScreenMedia, supportsWebRtc, type ScreenSettings, type ScreenSubscription, type VideoSource } from "#lib/media/screen-media";
  import {
    defaultCameraCapture, defaultScreenCapture, getCapturePreferences, saveCapturePreferences, type CapturePreferences,
  } from "#lib/preferences";

  let { snapshot, visible, controlsTarget, inlineTarget, source = "screen" }: {
    snapshot: Snapshot; visible: boolean; controlsTarget?: HTMLElement; inlineTarget?: HTMLElement; source?: VideoSource;
  } = $props();
  interface Publication {
    id: string;
    title: string;
    capture: MediaStream;
    preview: MediaStream;
    settings: ScreenSettings;
    requestedAudio: boolean;
    session?: ScreenMedia;
    channel?: string;
    producerId?: string;
    seen: boolean;
    starting: boolean;
    closing: boolean;
    editing: boolean;
    failure: string;
  }

  let publications = $state<Publication[]>([]);
  let setupOpen = $state(false);
  let setupForm = $state<HTMLFormElement>();
  let choosing = $state(false);
  let publishing = $state(false);
  let draft = $state<MediaStream>();
  let editing = $state<Publication>();
  let setupVersion = 0;
  let incoming: ScreenMedia | undefined;
  let incomingChannel: string | null = null;
  const watched = new SvelteMap<string, { subscription: ScreenSubscription; stream?: MediaStream }>();
  const closing = new SvelteSet<string>();
  let stoppingReceiving = $state(false);
  let switchingCamera = $state(false);
  let error = $state("");
  let setupError = $state("");
  const initialCapture = untrack(() => source === "camera" ? defaultCameraCapture : defaultScreenCapture);
  let captureDefaults = $state.raw<CapturePreferences>(initialCapture);
  let resolution = $state(String(initialCapture.resolution ?? 0));
  let frameRate = $state(String(initialCapture.frameRate));
  let videoKbps = $state<number | undefined>(initialCapture.videoBitrate / 1000);
  let shareAudio = $state(false);
  let audioKbps = $state("128");
  let sourceHasAudio = $state(false);
  let requestedAudio = $state(false);
  let destroyed = false;

  const camera = $derived(source === "camera");
  const CaptureIcon = $derived(camera ? Video : MonitorUp);
  const WatchIcon = $derived(camera ? Video : Monitor);
  const StopIcon = $derived(camera ? VideoOff : Square);
  const title = $derived(camera ? "Camera" : editing ? `Edit ${editing.title.toLowerCase()}` : "Share screen");
  const cameraResolutions = [360, 480, 720, 1080].map((height) => ({ value: String(height), label: `${height}p` }));
  const screenResolutions = [{ value: "0", label: "Source" }, ...cameraResolutions, { value: "1440", label: "1440p" }];
  const frameRates = [5, 15, 30, 60].map((fps) => ({ value: String(fps), label: `${fps} FPS` }));
  const audioBitrates = [64, 96, 128, 192, 256, 320].map((bitrate) => ({ value: String(bitrate), label: String(bitrate) }));
  const canCapture = $derived(typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.[camera ? "getUserMedia" : "getDisplayMedia"] === "function");
  const availableShares = $derived(camera ? snapshot.cameras : snapshot.screens);
  const cameraPublication = $derived(camera ? publications[0] : undefined);
  const member = $derived(snapshot.members.find(({ connectionId }) => connectionId === snapshot.connectionId));
  const canReceive = $derived(Boolean(snapshot.channelId) && !member?.deafened && !member?.adminDeafened && !member?.afk);
  const hasSharePermission = $derived((camera ? snapshot.canUseCamera ?? snapshot.canShareScreen : snapshot.canShareScreen) !== false);
  const canShare = $derived(hasSharePermission && canReceive && !member?.adminMuted);
  const shares = $derived((availableShares ?? []).filter(({ connectionId }) => connectionId !== snapshot.connectionId));
  const cameraWatch = $derived(camera ? watched.values().next().value : undefined);
  const ownScreens = $derived(publications.map((entry) => ({
    id: entry.id,
    title: entry.title,
    stream: entry.preview,
    live: Boolean(entry.producerId && entry.channel === snapshot.channelId),
    status: entry.failure || (!snapshot.channelId ? "Sharing paused. Join a voice channel to resume."
      : !canShare ? "Sharing paused. Screen sharing is unavailable in this channel."
      : !entry.producerId ? "Connecting screen share…" : ""),
    error: Boolean(entry.failure),
    edit: () => openSetup(entry),
    stop: () => stopPublication(entry),
    resume: canShare && entry.failure ? () => { entry.failure = ""; } : undefined,
  })));
  const screenEntries = $derived(shares.map((share) => {
    const number = share.screenNumber ?? 1;
    const name = presenter(share.connectionId);
    const title = `${name}’s screen${number > 1 ? ` ${number}` : ""}`;
    const watch = watched.get(share.producerId);
    return {
      id: share.producerId,
      title,
      stream: watch?.stream,
      loading: Boolean(watch && !watch.stream),
      disabled: !canReceive || stoppingReceiving || closing.has(share.producerId),
      watch: () => watchShare(share),
      stop: () => stopWatching(share.producerId),
    };
  }));

  $effect(() => {
    if (!setupOpen) untrack(clearDraft);
  });

  $effect(() => {
    const channel = snapshot.channelId;
    const live = availableShares ?? [];
    if (!canShare && !editing && setupOpen && !publishing) setupOpen = false;
    for (const entry of publications) {
      const present = live.some(({ producerId }) => producerId === entry.producerId);
      if (present) entry.seen = true;
      const ended = entry.seen && !present;
      if (!canShare || entry.channel !== channel) {
        entry.failure = "";
        if (entry.session) {
          if (camera) untrack(() => { void stopPublication(entry); });
          else untrack(() => { void closePublication(entry); });
        }
      } else if (entry.session && ended) {
        if (camera) untrack(() => { void stopPublication(entry); });
        else untrack(() => { void closePublication(entry); });
      }
      if (canShare && !entry.session && !entry.starting && !entry.closing && !entry.editing && !entry.failure) {
        untrack(() => { void publish(entry); });
      }
    }
  });

  $effect(() => {
    if (!canReceive || (incoming && incomingChannel !== snapshot.channelId)) {
      if (incoming) void stopReceiving();
      return;
    }
    for (const [id, { subscription }] of watched) {
      const share = shares.find(({ producerId }) => producerId === id);
      if (!share) void stopWatching(id);
      else subscription.setAudioProducer(share.audioProducerId);
    }
  });

  onMount(() => {
    void getCapturePreferences(source).then((saved) => {
      if (destroyed) return;
      captureDefaults = saved;
      if (!setupOpen && !publishing && !editing) {
        resolution = String(saved.resolution ?? 0);
        frameRate = String(saved.frameRate);
        videoKbps = saved.videoBitrate / 1000;
      }
    }).catch(() => {});
  });

  onDestroy(() => {
    destroyed = true;
    clearDraft();
    for (const entry of publications) {
      stopCapture(entry.capture);
      void entry.session?.close();
    }
    void incoming?.close();
  });

  function media(failed: (message: string) => void) {
    return new ScreenMedia(snapshot.connectionId, snapshot.channelId!, failed, source);
  }

  function stopCapture(stream?: MediaStream) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  function clearDraft() {
    if (draft && draft !== editing?.capture && !publications.some((entry) => entry.capture === draft)) stopCapture(draft);
    draft = undefined;
    editing = undefined;
  }

  function openSetup(entry?: Publication) {
    if (setupOpen || publishing || entry?.starting || entry?.closing) return;
    if (!supportsWebRtc()) {
      error = "This browser does not support WebRTC. Open Korero.chat in a browser with WebRTC support.";
      return;
    }
    clearDraft();
    setupVersion++;
    setupError = "";
    editing = entry;
    draft = entry?.capture;
    resolution = entry ? String(entry.settings.resolution ?? 0) : String(captureDefaults.resolution ?? 0);
    frameRate = String(entry?.settings.frameRate ?? captureDefaults.frameRate);
    videoKbps = entry ? entry.settings.videoBitrate / 1000 : captureDefaults.videoBitrate / 1000;
    shareAudio = entry?.settings.audio ?? false;
    audioKbps = String((entry?.settings.audioBitrate ?? 128000) / 1000);
    requestedAudio = entry?.requestedAudio ?? false;
    sourceHasAudio = Boolean(draft?.getAudioTracks().some((track) => track.readyState === "live"));
    setupOpen = true;
  }

  async function selectSource() {
    if (choosing || publishing || (!canShare && !editing)) return;
    choosing = true;
    setupError = "";
    const audio = shareAudio;
    const version = setupVersion;
    try {
      const stream = camera ? await navigator.mediaDevices.getUserMedia({
        video: { height: { ideal: Number(resolution) || 720 }, frameRate: { ideal: Number(frameRate) } }, audio: false,
      }) : await chooseScreen(audio);
      if (destroyed || !setupOpen || version !== setupVersion || (!canShare && !editing)) {
        stopCapture(stream);
        return;
      }
      if (draft !== editing?.capture) stopCapture(draft);
      draft = stream;
      requestedAudio = audio;
      sourceHasAudio = stream.getAudioTracks().length > 0;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (draft === stream && !publications.some((entry) => entry.capture === stream)) {
          stopCapture(stream);
          draft = undefined;
        }
      }, { once: true });
    } catch (failure) {
      if (camera || !(failure instanceof DOMException && failure.name === "NotAllowedError")) setupError = messageFrom(failure);
    } finally {
      choosing = false;
    }
  }

  async function submitShare(event: SubmitEvent) {
    event.preventDefault();
    const stream = draft;
    if (!stream || publishing || videoKbps === undefined || (!canShare && !editing)) return;
    const settings = {
      resolution: Number(resolution) || null, frameRate: Number(frameRate), videoBitrate: videoKbps * 1000,
      audio: shareAudio, audioBitrate: Number(audioKbps) * 1000,
    };
    publishing = true;
    setupError = "";
    try {
      if (editing) {
        await editPublication(editing, stream, settings);
      } else {
        let number = 1;
        while (publications.some(({ id }) => id === `local-${number}`)) number++;
        publications.push({
          id: `local-${number}`, title: number === 1 ? "Your screen" : `Your screen ${number}`,
          capture: stream, preview: new MediaStream(stream.getVideoTracks()), settings, requestedAudio,
          seen: false, starting: false, closing: false, editing: false, failure: "",
        });
        const entry = publications[publications.length - 1];
        watchCapture(entry, stream);
        await publish(entry);
        if (entry.failure) {
          publications = publications.filter(({ id }) => id !== entry.id);
          setupError = entry.failure;
          return;
        }
      }
      captureDefaults = {
        resolution: settings.resolution, frameRate: settings.frameRate, videoBitrate: settings.videoBitrate,
      };
      void saveCapturePreferences(source, captureDefaults).catch(() => {});
      setupOpen = false;
    } catch (failure) {
      setupError = messageFrom(failure);
    } finally {
      publishing = false;
    }
  }

  function watchCapture(entry: Publication, stream: MediaStream) {
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (entry.capture === stream && publications.includes(entry)) void stopPublication(entry);
    }, { once: true });
  }

  async function editPublication(entry: Publication, stream: MediaStream, settings: ScreenSettings) {
    const previous = entry.capture;
    const session = entry.session;
    entry.editing = true;
    try {
      if (session && entry.producerId) {
        try {
          await session.updateShare(stream, settings);
        } catch (failure) {
          if (entry.session === session) {
            try {
              await session.updateShare(previous, entry.settings);
            } catch {
              await closePublication(entry);
            }
          }
          throw failure;
        }
      }
      if (destroyed || !publications.includes(entry)) return;
      if (stream !== previous) {
        for (const track of entry.preview.getTracks()) entry.preview.removeTrack(track);
        for (const track of stream.getVideoTracks()) entry.preview.addTrack(track);
        entry.capture = stream;
        watchCapture(entry, stream);
        stopCapture(previous);
      }
      entry.settings = settings;
      entry.requestedAudio = requestedAudio;
      entry.failure = "";
    } finally {
      entry.editing = false;
    }
  }

  async function publish(entry: Publication) {
    const channel = snapshot.channelId;
    if (!channel || destroyed || !canShare || entry.session || entry.starting || entry.closing) return;
    entry.channel = channel;
    entry.starting = true;
    const session = media((message) => {
      if (entry.session !== session) return;
      if (camera) {
        error = message;
        void stopPublication(entry);
      } else {
        entry.failure = message;
        void closePublication(entry);
      }
    });
    entry.session = session;
    try {
      const id = await session.share(entry.capture, entry.settings);
      if (entry.session === session && snapshot.channelId === channel) entry.producerId = id;
    } catch (failure) {
      if (entry.session !== session) return;
      if (snapshot.channelId === channel && canShare) entry.failure = messageFrom(failure);
      await closePublication(entry);
    } finally {
      entry.starting = false;
    }
  }

  async function stopPublication(entry: Publication) {
    publications = publications.filter(({ id }) => id !== entry.id);
    if (editing === entry) setupOpen = false;
    stopCapture(entry.capture);
    await closePublication(entry);
  }

  async function closePublication(entry: Publication) {
    const session = entry.session;
    if (!session) return;
    entry.closing = true;
    entry.session = undefined;
    entry.producerId = undefined;
    entry.seen = false;
    try {
      await session.close();
    } finally {
      entry.closing = false;
    }
  }

  async function watchShare(share: ScreenShare) {
    const id = share.producerId;
    if (!canReceive || stoppingReceiving || closing.has(id) || watched.has(id) || switchingCamera) return;
    if (camera && watched.size) {
      switchingCamera = true;
      try {
        await stopWatching(watched.keys().next().value!);
      } finally {
        switchingCamera = false;
      }
    }
    if (destroyed || !canReceive || stoppingReceiving || !shares.some(({ producerId }) => producerId === id)) return;
    error = "";
    if (!incoming) {
      const session = media((message) => {
        if (incoming !== session) return;
        error = message;
        void stopReceiving();
      });
      incomingChannel = snapshot.channelId;
      incoming = session;
    }
    const subscription = incoming.watch(share);
    watched.set(id, { subscription });
    try {
      const stream = await subscription.stream;
      if (!destroyed && watched.get(id)?.subscription === subscription) watched.set(id, { subscription, stream });
    } catch (failure) {
      if (destroyed || watched.get(id)?.subscription !== subscription) return;
      error = camera ? messageFrom(failure) : `${presenter(share.connectionId)}’s screen: ${messageFrom(failure)}`;
      await stopWatching(id);
    }
  }

  async function stopWatching(id: string) {
    const entry = watched.get(id);
    if (!entry) return;
    closing.add(id);
    watched.delete(id);
    try {
      if (watched.size) await entry.subscription.close();
      else await stopReceiving();
    } finally {
      closing.delete(id);
    }
  }

  async function stopReceiving() {
    const session = incoming;
    incoming = undefined;
    incomingChannel = null;
    stoppingReceiving = true;
    watched.clear();
    try {
      await session?.close();
    } finally {
      stoppingReceiving = false;
    }
  }

  function presenter(connectionId: string) {
    return snapshot.members.find((member) => member.connectionId === connectionId)?.displayName ?? "Channel member";
  }

  function showPreview(element: HTMLVideoElement, stream: MediaStream) {
    element.srcObject = stream;
    return () => { element.srcObject = null; };
  }
</script>

{#if camera}
  {#if visible && (shares.length || cameraPublication?.producerId || cameraWatch || error)}
    <section class="camera-sharing" aria-label="Camera video">
      {#if shares.length}
        <div class="camera-actions">
          {#each shares as share (share.producerId)}
            {@const watching = watched.has(share.producerId)}
            <Button variant={watching ? "default" : "outline"}
              disabled={!canReceive || stoppingReceiving || switchingCamera || closing.size > 0}
              onclick={() => watching ? stopWatching(share.producerId) : watchShare(share)}>
              {#if watching}<X size={15} /> Stop watching
              {:else}<WatchIcon size={15} /> Watch {presenter(share.connectionId)}’s camera{/if}
            </Button>
          {/each}
        </div>
      {/if}
      {#if cameraWatch?.stream || cameraPublication?.producerId}
        {@const stream = cameraWatch?.stream ?? cameraPublication!.capture}
        <video autoplay muted playsinline aria-label={cameraWatch?.stream ? "Shared camera" : "Your camera preview"}
          {@attach (element) => showPreview(element, stream)}></video>
      {:else if cameraWatch}
        <p role="status">Opening camera…</p>
      {/if}
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    </section>
  {/if}
{:else}
  <ScreenShareViewer entries={screenEntries} own={ownScreens} {inlineTarget} {visible} {error} />
{/if}

{#if cameraPublication || (visible && canCapture && snapshot.channelId && hasSharePermission)}
  <Portal to={controlsTarget ?? "body"}>
    <div class={controlsTarget ? "contents" : "share-controls-fallback"}>
      <Button variant={cameraPublication ? "secondary" : "outline"} aria-pressed={camera ? Boolean(cameraPublication) : undefined}
        title={camera ? (cameraPublication ? "Turn off camera" : "Turn on camera") : "Share screen"}
        onclick={() => cameraPublication ? stopPublication(cameraPublication) : openSetup()}
        disabled={!cameraPublication && (!canShare || publishing)}>
        {#if cameraPublication}<StopIcon size={15} aria-hidden="true" />{:else}<CaptureIcon size={15} aria-hidden="true" />{/if}
        {camera ? "Camera" : publications.length ? "Share another screen" : "Screenshare"}
      </Button>
    </div>
  </Portal>
{/if}

<Modal bind:open={setupOpen} {title} description={camera ? "Preview your camera and choose the quality before sharing video with this channel."
    : editing ? "Change the source or quality of this screen share." : "Choose a window, tab, or entire display to share with this channel."}
    dismissible={!publishing}>
    <form class="dialog-form" bind:this={setupForm} onsubmit={submitShare}>
      {#if draft}
        <video autoplay muted playsinline aria-label="Source preview" {@attach (element) => showPreview(element, draft!)}></video>
      {/if}
      {#if !camera || !draft}
        <Button type="button" variant="outline" onclick={selectSource} disabled={choosing || publishing}>
          <WatchIcon size={16} /> {camera ? (choosing ? "Opening camera…" : "Preview camera")
            : (choosing ? "Opening source picker…" : draft ? "Change source" : "Choose source")}
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
      {#if shareAudio && !draft}
        <p class="field-hint">Audio availability depends on the selected source and your browser or operating system.</p>
      {:else if shareAudio && draft && !requestedAudio}
        <p class="field-hint">Choose the source again to request its audio.</p>
      {:else if shareAudio && draft && !sourceHasAudio}
        <p class="field-hint">This source supplied video only. Choose a different source to include audio.</p>
      {/if}
      {#if setupError}<p class="form-error" role="alert">{setupError}</p>{/if}
      <div class="dialog-actions">
        <Button type="button" variant="outline" onclick={() => { setupOpen = false; }} disabled={publishing}>Cancel</Button>
        <Button type="submit" variant="default" disabled={!draft || choosing || publishing || (shareAudio && !requestedAudio)}>
          {publishing ? (editing ? "Saving…" : "Starting…") : editing ? "Save changes" : camera ? "Start camera" : "Go live"}
        </Button>
      </div>
    </form>
</Modal>

<style>
  .camera-sharing { border-bottom: 1px solid var(--border); }
  .camera-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .camera-actions, .camera-sharing p { padding: 8px var(--ui-gap); }
  .share-controls-fallback { position: fixed; z-index: 41; top: 12px; right: 12px; display: flex; gap: 6px; }
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
