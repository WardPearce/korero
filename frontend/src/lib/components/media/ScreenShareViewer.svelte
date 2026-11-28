<script lang="ts">
  import { Portal } from "bits-ui";
  import { ExternalLink, LayoutGrid, Maximize, Minimize, PanelTop, Pencil, Play, Square, Volume2, VolumeX, X } from "@lucide/svelte";
  import { onDestroy, onMount, tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as ContextMenu from "#lib/components/ui/context-menu/index.js";
  import { Root as Slider } from "#lib/components/ui/slider/index.js";
  import { openScreenPopout, type ScreenPlayback } from "#lib/media/screen-popout";
  import { defaultScreenPlayback, getScreenPlayback, saveScreenPlayback } from "#lib/preferences";

  interface Share {
    id: string;
    title: string;
    stream?: MediaStream;
    loading: boolean;
    disabled: boolean;
    watch: () => Promise<void>;
    stop: () => Promise<void>;
  }

  interface OwnShare {
    id: string;
    title: string;
    stream: MediaStream;
    live: boolean;
    status: string;
    error: boolean;
    edit: () => void;
    stop: () => Promise<void>;
    resume?: () => void;
  }

  interface Tile {
    id: string;
    title: string;
    live: boolean;
    stream?: MediaStream;
    share?: Share;
    own?: OwnShare;
  }

  let { entries, own, visible, inlineTarget, error }: {
    entries: Share[];
    own: OwnShare[];
    visible: boolean;
    inlineTarget?: HTMLElement;
    error: string;
  } = $props();

  let fullscreenGrid = $state(false);
  let focusedShare = $state<string>();
  let fullscreenDialog = $state<HTMLDialogElement>();
  let inlineViewer = $state<HTMLElement>();
  let popoutError = $state("");
  let volumeSlider = $state<HTMLElement | null>(null);
  const popouts = new SvelteMap<string, NonNullable<ReturnType<typeof openScreenPopout>> & { stream: MediaStream }>();
  const playback = new SvelteMap<string, ScreenPlayback>();
  const videos = new Map<string, HTMLVideoElement>();
  let defaultPlayback = $state<ScreenPlayback>({ ...defaultScreenPlayback });
  const tiles: Tile[] = $derived([
    ...own.map((entry) => ({ id: entry.id, title: entry.title, live: entry.live, stream: entry.stream, own: entry })),
    ...entries.map((share) => ({ id: share.id, title: share.title, live: true, stream: share.stream, share })),
  ]);
  const playing = $derived(tiles.filter(({ id, stream }) => stream && !popouts.has(id)));
  const active = $derived(tiles.filter((tile) => tile.stream || tile.share?.loading));
  const focusedTile = $derived(playing.find(({ id }) => id === focusedShare));
  const stage = $derived(focusedTile ? [focusedTile] : playing);

  $effect(() => {
    for (const [id, popup] of popouts) {
      if (!tiles.some((tile) => tile.id === id && tile.stream === popup.stream)) popup.close();
    }
    for (const id of playback.keys()) {
      if (!tiles.some((tile) => tile.id === id && tile.stream)) playback.delete(id);
    }
    if (focusedShare && !focusedTile) focusedShare = undefined;
    if (fullscreenGrid && !playing.length) fullscreenGrid = false;
  });

  onMount(() => {
    let cancelled = false;
    void getScreenPlayback().then((saved) => {
      if (cancelled) return;
      defaultPlayback = saved;
      applyDefaultPlayback(saved);
    }).catch(() => {});
    return () => { cancelled = true; };
  });

  onDestroy(() => {
    for (const popup of popouts.values()) popup.close();
  });

  function playbackFor(id: string): ScreenPlayback {
    return playback.get(id) ?? defaultPlayback;
  }

  function applyPlayback(id: string, settings: ScreenPlayback) {
    const video = videos.get(id);
    if (video) {
      video.muted = settings.muted;
      video.volume = settings.volume;
    }
    popouts.get(id)?.setPlayback(settings);
  }

  function applyDefaultPlayback(settings: ScreenPlayback) {
    for (const id of videos.keys()) {
      if (!playback.has(id)) applyPlayback(id, settings);
    }
    for (const id of popouts.keys()) {
      if (!playback.has(id)) applyPlayback(id, settings);
    }
  }

  function updatePlayback(id: string, patch: Partial<ScreenPlayback>, persist = true) {
    const next = { ...playbackFor(id), ...patch };
    playback.set(id, next);
    applyPlayback(id, next);
    if (persist) {
      defaultPlayback = next;
      applyDefaultPlayback(next);
      void saveScreenPlayback(next).catch(() => {});
    }
  }

  function toggleMute(id: string) {
    const { muted, volume } = playbackFor(id);
    updatePlayback(id, muted ? { muted: false, volume: volume || 1 } : { muted: true });
  }

  function changeVolume(id: string, percent: number, persist = true) {
    updatePlayback(id, { volume: percent / 100, muted: percent === 0 }, persist);
  }

  function attachStream(video: HTMLVideoElement, id: string, stream: MediaStream) {
    const settings = playbackFor(id);
    video.muted = settings.muted;
    video.volume = settings.volume;
    video.srcObject = stream;
    videos.set(id, video);
    if (!settings.muted) {
      void video.play().catch(() => {
        // Browsers can block audible autoplay. Keep the share playing and reflect the muted state.
        video.muted = true;
        playback.set(id, { ...playbackFor(id), muted: true });
        void video.play().catch(() => {});
      });
    }
    return () => {
      video.srcObject = null;
      if (videos.get(id) === video) videos.delete(id);
    };
  }

  function popOut(tile: Tile) {
    if (!tile.stream || popouts.has(tile.id)) return;
    popoutError = "";
    const popup = openScreenPopout(tile.stream, tile.title, playbackFor(tile.id),
      () => popouts.delete(tile.id),
      tile.share?.stop);
    if (popup) popouts.set(tile.id, { ...popup, stream: tile.stream });
    else popoutError = "Couldn’t open the screen share window. Check your pop-up settings and try again.";
  }

  function showFullscreen(dialog: HTMLDialogElement) {
    fullscreenDialog = dialog;
    dialog.showModal();
    return () => {
      dialog.close();
      fullscreenDialog = undefined;
    };
  }

  function openFullscreenGrid() {
    fullscreenGrid = true;
    focusedShare = undefined;
  }

  async function focusShare(id: string) {
    focusedShare = id;
    await tick();
    fullscreenDialog?.querySelector<HTMLButtonElement>("[data-back-to-grid]")?.focus();
  }

  async function backToGrid() {
    if (!fullscreenGrid) {
      await exitFullscreen();
      return;
    }
    const trigger = focusedShare;
    focusedShare = undefined;
    await tick();
    restoreFocus(fullscreenDialog, trigger);
  }

  async function exitFullscreen() {
    const trigger = fullscreenGrid ? "true" : focusedShare;
    fullscreenGrid = false;
    focusedShare = undefined;
    await tick();
    restoreFocus(inlineViewer, trigger);
  }

  function restoreFocus(viewer: HTMLElement | undefined, trigger: string | undefined) {
    const buttons = viewer?.querySelectorAll<HTMLButtonElement>("button[data-fullscreen]");
    for (const button of buttons ?? []) {
      if (button.dataset.fullscreen === trigger) {
        button.focus();
        return;
      }
    }
  }
</script>

{#snippet tileContent(tile: Tile, canFocus: boolean)}
  {@const id = tile.id}
  {@const stream = tile.stream}
  {@const popup = popouts.get(id)}
  {@const volumeLabelId = `${id}-volume`}
  <ContextMenu.Root>
    <ContextMenu.Trigger class="block min-w-0">
      <article class="share-tile" aria-label={tile.title}>
        <header class="tile-header">
          {#if tile.live}<span class="live-dot" aria-label="Live" role="img"></span>{/if}
          <span class="tile-name truncate" title={tile.title}>{tile.title}</span>
          {#if tile.stream && !popup}
            {#if canFocus}
              <Button size="icon-sm" variant="ghost" data-fullscreen={tile.id}
                aria-label={`Fullscreen ${tile.title}`} title="Fullscreen in app" onclick={() => focusShare(id)}>
                <Maximize aria-hidden="true" />
              </Button>
            {/if}
            <Button size="icon-sm" variant="ghost" aria-label={`Pop out ${tile.title}`} title="Open in separate window"
              onclick={() => popOut(tile)}>
              <ExternalLink aria-hidden="true" />
            </Button>
          {/if}
          {#if tile.own}
            <Button size="icon-sm" variant="ghost" aria-label={`Edit ${tile.title}`} title="Edit screen share" onclick={tile.own.edit}>
              <Pencil aria-hidden="true" />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Stop sharing ${tile.title}`} title="Stop sharing" onclick={tile.own.stop}>
              <Square aria-hidden="true" />
            </Button>
          {:else if tile.share && (tile.stream || tile.share.loading)}
            <Button size="sm" variant="ghost" aria-label={`Stop watching ${tile.title}`}
              onclick={tile.share.stop}>
              <X aria-hidden="true" /> Stop watching
            </Button>
          {/if}
        </header>

        {#if popup}
          <div class="tile-placeholder">
            <Button size="sm" variant="outline" onclick={popup.focus}>Show window</Button>
            <Button size="sm" variant="ghost" onclick={popup.close}><PanelTop aria-hidden="true" /> Return to app</Button>
          </div>
        {:else if stream}
          <div class="tile-video">
            <video autoplay playsinline aria-label={tile.title}
              {@attach (node) => attachStream(node, id, stream)}></video>
            {#if canFocus}
              <button type="button" class="focus-preview" aria-label={`Focus ${tile.title}`}
                onclick={() => focusShare(id)}></button>
            {/if}
          </div>
        {:else if tile.share?.loading}
          <div class="tile-placeholder" role="status">Opening screen share…</div>
        {:else if tile.share}
          <button type="button" class="join-share" disabled={tile.share.disabled}
            aria-label={`Join screenshare from ${tile.title}`} onclick={tile.share.watch}>
            <span class="join-share-icon"><Play size={18} aria-hidden="true" /></span>
            <span class="join-share-copy">
              <span class="join-share-title">Join screenshare</span>
              <span class="join-share-hint">Watch {tile.title} live</span>
            </span>
          </button>
        {/if}
        {#if tile.own?.status}
          <div class="tile-status">
            <span class={tile.own.error ? "form-error" : undefined} role={tile.own.error ? "alert" : "status"}>{tile.own.status}</span>
            {#if tile.own.resume}<Button size="sm" variant="outline" onclick={tile.own.resume}>Resume sharing</Button>{/if}
          </div>
        {/if}
      </article>
    </ContextMenu.Trigger>
    <ContextMenu.Content class="max-w-[calc(100vw-1rem)]" portalProps={{ to: fullscreenDialog ?? "body" }}>
      <ContextMenu.Item closeOnSelect={false} onSelect={() => toggleMute(id)}>
        {#if playbackFor(id).muted}
          <Volume2 aria-hidden="true" /> Unmute screen
        {:else}
          <VolumeX aria-hidden="true" /> Mute screen
        {/if}
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item closeOnSelect={false} aria-labelledby={volumeLabelId} class="min-w-44 flex-col items-stretch gap-0"
        onSelect={() => volumeSlider?.querySelector<HTMLElement>('[role="slider"]')?.focus()}>
        <div class="flex items-center gap-1.5">
          <Volume2 aria-hidden="true" />
          <span id={volumeLabelId}>Volume</span>
          <span class="ml-auto tabular-nums">{Math.round(playbackFor(id).volume * 100)}%</span>
        </div>
        <Slider type="single" min={0} max={100} class="min-h-6" thumbLabelledBy={volumeLabelId}
          bind:ref={volumeSlider} value={Math.round(playbackFor(id).volume * 100)}
          onValueChange={(level) => changeVolume(id, level, false)}
          onValueCommit={(level) => changeVolume(id, level)} />
      </ContextMenu.Item>
      {#if tile.share && (stream || tile.share.loading || popup)}
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={() => tile.share?.stop()}>
          <X aria-hidden="true" /> Stop watching
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
{/snippet}

{#snippet errors()}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  {#if popoutError}<p class="form-error" role="alert">{popoutError}</p>{/if}
{/snippet}

{#if (fullscreenGrid || focusedTile) && stage.length}
  <dialog class="share-fullscreen" aria-label="Fullscreen screen shares" {@attach showFullscreen}
    oncancel={(event) => { event.preventDefault(); void exitFullscreen(); }}>
    <header class="viewer-header">
      <h2 class="truncate">{focusedTile?.title ?? "Screen shares"}</h2>
      {#if focusedTile}
        <Button size="sm" variant="outline" data-back-to-grid onclick={backToGrid}>
          <LayoutGrid aria-hidden="true" /> Back to grid
        </Button>
        {#if !fullscreenGrid && playing.length > 1}
          <Button size="sm" variant="outline" onclick={openFullscreenGrid}>
            <Maximize aria-hidden="true" /> Fullscreen grid
          </Button>
        {/if}
      {/if}
      {#if fullscreenGrid}
        <Button size="sm" variant="outline" onclick={exitFullscreen}>
          <Minimize aria-hidden="true" /> Exit fullscreen
        </Button>
      {/if}
    </header>
    {@render errors()}
    <div class={["share-grid", { single: stage.length === 1 }]}>
      {#each stage as tile (tile.id)}
        {@render tileContent(tile, !focusedTile)}
      {/each}
    </div>
  </dialog>
{:else if (visible && (tiles.length || error || popoutError)) || active.length}
  <Portal to={visible && inlineTarget ? inlineTarget : "body"} disabled={visible && !inlineTarget}>
    <section class={["share-viewer", { floating: !visible }]} aria-label="Screen sharing" bind:this={inlineViewer}>
      <header class="viewer-header">
        <h2>Screen shares</h2>
        {#if playing.length > 1}
          <Button size="sm" variant="outline" data-fullscreen="true" onclick={openFullscreenGrid}>
            <Maximize aria-hidden="true" /> Fullscreen grid
          </Button>
        {/if}
      </header>
      <div class="share-grid">
        {#each (visible ? tiles : active) as tile (tile.id)}
          {@render tileContent(tile, true)}
        {/each}
      </div>
      {@render errors()}
    </section>
  </Portal>
{/if}

<style>
  .share-viewer, .share-fullscreen {
    display: flex;
    min-width: 0;
    flex-direction: column;
    background: var(--background);
  }
  .share-viewer {
    max-height: 52dvh;
    border-bottom: 1px solid var(--border);
  }
  .floating {
    position: fixed;
    z-index: 40;
    right: 12px;
    bottom: max(12px, var(--safe-area-inset-bottom));
    width: min(36rem, calc(100% - 24px));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-floating);
  }
  .viewer-header, .tile-header { display: flex; align-items: center; gap: 6px; }
  .viewer-header { padding: 6px var(--ui-gap); }
  .viewer-header h2 { flex: 1; min-width: 0; font-size: var(--type-small); font-weight: 650; }
  .share-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
    gap: 8px;
    padding: 0 var(--ui-gap) 8px;
    overflow: auto;
    min-height: 0;
  }
  .share-tile {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .tile-header { padding: 4px 6px 4px 8px; min-height: 39px; }
  .tile-name { flex: 1; min-width: 0; font-size: var(--type-small); font-weight: 600; }
  .live-dot { flex: none; width: .45rem; height: .45rem; border-radius: 50%; background: var(--destructive); }
  .tile-placeholder {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 3rem;
    padding: 4px 6px;
    font-size: var(--type-small);
  }
  .join-share {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 8rem;
    padding: 12px;
    border: 0;
    background: var(--muted);
    color: var(--foreground);
    cursor: pointer;
    font: inherit;
    text-align: center;
    transition: background-color 120ms ease-out;
  }
  .join-share:hover:not(:disabled) { background: var(--control-hover); }
  .join-share:focus-visible { outline: var(--focus-ring); outline-offset: -4px; }
  .join-share:disabled { cursor: not-allowed; opacity: .55; }
  .join-share-icon {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid var(--input);
    border-radius: 50%;
    color: var(--primary);
  }
  .join-share:hover:not(:disabled) .join-share-icon { border-color: var(--primary); }
  .join-share-copy { display: grid; gap: 2px; max-width: 22rem; min-width: 0; }
  .join-share-title { font-size: var(--type-small); font-weight: 650; }
  .join-share-hint { font-size: var(--type-caption); color: var(--muted-foreground); overflow-wrap: anywhere; }
  .tile-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; font-size: var(--type-small); }
  .tile-video { position: relative; display: flex; flex-direction: column; }
  .focus-preview { position: absolute; inset: 0; cursor: zoom-in; }
  .focus-preview:focus-visible { outline: var(--focus-ring); outline-offset: -4px; }
  video { display: block; width: 100%; aspect-ratio: 16 / 9; max-height: 32dvh; background: #111; object-fit: contain; }
  .share-viewer p, .share-fullscreen p { padding: 6px var(--ui-gap); }
  .share-fullscreen {
    position: fixed;
    inset: 0;
    margin: 0;
    padding: 0;
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    color: var(--foreground);
  }
  .share-fullscreen:not([open]) { display: none; }
  .share-fullscreen .share-grid {
    flex: 1;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, max(18rem, 30%)), 1fr));
    grid-auto-rows: minmax(min(35dvh, 16rem), 1fr);
  }
  .share-fullscreen .share-grid.single { grid-template-columns: minmax(0, 1fr); }
  .share-fullscreen .tile-video { flex: 1; min-height: 0; }
  .share-fullscreen video { flex: 1; height: 0; min-height: 0; max-height: none; aspect-ratio: auto; }
  @media (max-width: 560px) {
    .share-fullscreen .share-grid { grid-template-columns: 1fr; }
  }
</style>
