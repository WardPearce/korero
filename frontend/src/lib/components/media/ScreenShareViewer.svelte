<script lang="ts">
  import { Portal } from "bits-ui";
  import { ExternalLink, Maximize, Minimize, PanelTop, Pencil, Play, Square, X } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { Button } from "#lib/components/ui/button/index.js";
  import { openScreenPopout } from "#lib/media/screen-popout";

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

  let fullscreen = $state<string | true>();
  let inlineViewer = $state<HTMLElement>();
  let popoutError = $state("");
  const popouts = new SvelteMap<string, NonNullable<ReturnType<typeof openScreenPopout>> & { stream: MediaStream }>();
  const playback = new Map<string, { muted: boolean; volume: number }>();
  const tiles: Tile[] = $derived([
    ...own.map((entry) => ({ id: entry.id, title: entry.title, live: entry.live, stream: entry.stream, own: entry })),
    ...entries.map((share) => ({ id: share.id, title: share.title, live: true, stream: share.stream, share })),
  ]);
  const playing = $derived(tiles.filter(({ id, stream }) => stream && !popouts.has(id)));
  const active = $derived(tiles.filter((tile) => tile.stream || tile.share?.loading));
  const stage = $derived(fullscreen === true ? playing : playing.filter(({ id }) => id === fullscreen));

  $effect(() => {
    for (const [id, popup] of popouts) {
      if (!tiles.some((tile) => tile.id === id && tile.stream === popup.stream)) popup.close();
    }
    for (const id of playback.keys()) {
      if (!tiles.some((tile) => tile.id === id && tile.stream)) playback.delete(id);
    }
    if (fullscreen && !stage.length) fullscreen = undefined;
  });

  onDestroy(() => {
    for (const popup of popouts.values()) popup.close();
  });

  function attachStream(video: HTMLVideoElement, id: string, stream: MediaStream) {
    const settings = playback.get(id);
    video.muted = settings?.muted ?? true;
    video.volume = settings?.volume ?? 1;
    video.srcObject = stream;
    return () => { video.srcObject = null; };
  }

  function popOut(tile: Tile) {
    if (!tile.stream || popouts.has(tile.id)) return;
    popoutError = "";
    const popup = openScreenPopout(tile.stream, tile.title, playback.get(tile.id) ?? { muted: true, volume: 1 },
      (settings) => playback.set(tile.id, settings),
      () => popouts.delete(tile.id),
      tile.share?.stop);
    if (popup) popouts.set(tile.id, { ...popup, stream: tile.stream });
    else popoutError = "Couldn’t open the screen share window. Check your pop-up settings and try again.";
  }

  function showFullscreen(dialog: HTMLDialogElement) {
    dialog.showModal();
    return () => dialog.close();
  }

  async function exitFullscreen() {
    const trigger = fullscreen;
    fullscreen = undefined;
    await tick();
    const buttons = inlineViewer?.querySelectorAll<HTMLButtonElement>("button[data-fullscreen]");
    for (const button of buttons ?? []) {
      if (button.dataset.fullscreen === String(trigger)) {
        button.focus();
        return;
      }
    }
  }
</script>

{#snippet tileContent(tile: Tile, expanded: boolean)}
  {@const id = tile.id}
  {@const stream = tile.stream}
  {@const popup = popouts.get(id)}
  <article class="share-tile" aria-label={tile.title}>
    <header class="tile-header">
      {#if tile.live}<span class="live-dot" aria-label="Live" role="img"></span>{/if}
      <span class="tile-name truncate" title={tile.title}>{tile.title}</span>
      {#if tile.stream && !popup}
        {#if !expanded || fullscreen === true}
          <Button size="icon-sm" variant="ghost" data-fullscreen={tile.id}
            aria-label={`Fullscreen ${tile.title}`} title="Fullscreen in app" onclick={() => { fullscreen = tile.id; }}>
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
      <video autoplay muted playsinline controls={Boolean(tile.share)} aria-label={tile.title}
        {@attach (node) => attachStream(node, id, stream)}
        onvolumechange={(event) => {
          const video = event.currentTarget;
          playback.set(tile.id, { muted: video.muted, volume: video.volume });
        }}></video>
    {:else if tile.share?.loading}
      <div class="tile-placeholder" role="status">Opening screen share…</div>
    {:else if tile.share}
      <div class="tile-placeholder">
        <Button size="sm" variant="outline" disabled={tile.share.disabled}
          aria-label={`Join screenshare from ${tile.title}`} onclick={tile.share.watch}>
          <Play aria-hidden="true" /> Join screenshare
        </Button>
      </div>
    {/if}
    {#if tile.own?.status}
      <div class="tile-status">
        <span class={tile.own.error ? "form-error" : undefined} role={tile.own.error ? "alert" : "status"}>{tile.own.status}</span>
        {#if tile.own.resume}<Button size="sm" variant="outline" onclick={tile.own.resume}>Resume sharing</Button>{/if}
      </div>
    {/if}
  </article>
{/snippet}

{#snippet errors()}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  {#if popoutError}<p class="form-error" role="alert">{popoutError}</p>{/if}
{/snippet}

{#if fullscreen && stage.length}
  <dialog class="share-fullscreen" aria-label="Fullscreen screen shares" {@attach showFullscreen}
    oncancel={(event) => { event.preventDefault(); void exitFullscreen(); }}>
    <header class="viewer-header">
      <h2 class="truncate">{fullscreen === true ? "Screen shares" : stage[0].title}</h2>
      {#if fullscreen !== true && playing.length > 1}
        <Button size="sm" variant="outline" onclick={() => { fullscreen = true; }}>View all</Button>
      {/if}
      <Button size="sm" variant="outline" onclick={exitFullscreen}>
        <Minimize aria-hidden="true" /> Exit fullscreen
      </Button>
    </header>
    {@render errors()}
    <div class={["share-grid", { single: stage.length === 1 }]}>
      {#each stage as tile (tile.id)}
        {@render tileContent(tile, true)}
      {/each}
    </div>
  </dialog>
{:else if (visible && (tiles.length || error || popoutError)) || active.length}
  <Portal to={visible && inlineTarget ? inlineTarget : "body"} disabled={visible && !inlineTarget}>
    <section class={["share-viewer", { floating: !visible }]} aria-label="Screen sharing" bind:this={inlineViewer}>
      <header class="viewer-header">
        <h2>Screen shares</h2>
        {#if playing.length > 1}
          <Button size="sm" variant="outline" data-fullscreen="true" onclick={() => { fullscreen = true; }}>
            <Maximize aria-hidden="true" /> Fullscreen grid
          </Button>
        {/if}
      </header>
      <div class="share-grid">
        {#each (visible ? tiles : active) as tile (tile.id)}
          {@render tileContent(tile, false)}
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
    bottom: max(12px, env(safe-area-inset-bottom));
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
  .tile-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; font-size: var(--type-small); }
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
  .share-fullscreen video { flex: 1; height: 0; min-height: 0; max-height: none; aspect-ratio: auto; }
  @media (max-width: 560px) {
    .share-fullscreen .share-grid { grid-template-columns: 1fr; }
  }
</style>
