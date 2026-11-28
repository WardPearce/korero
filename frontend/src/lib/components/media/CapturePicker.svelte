<script lang="ts">
  import { AppWindow, Monitor } from "@lucide/svelte";
  import { onDestroy, onMount } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import Modal from "#lib/components/Modal.svelte";
  import { chooseCapture, watchDesktop, type CaptureRequest, type CaptureSource } from "#lib/connection/platform";

  let request = $state.raw<CaptureRequest>();
  let unlisten: (() => void) | undefined;
  let destroyed = false;

  const screens = $derived(request?.sources.filter(({ kind }) => kind === "screen") ?? []);
  const windows = $derived(request?.sources.filter(({ kind }) => kind === "window") ?? []);

  function answer(sourceId: string | null) {
    const current = request;
    if (!current) return;
    request = undefined;
    void chooseCapture(current.id, sourceId).catch(() => {});
  }

  onMount(async () => {
    const stop = await watchDesktop<CaptureRequest>("korero:capture-sources", (payload) => { request = payload; });
    if (destroyed) stop();
    else unlisten = stop;
  });

  onDestroy(() => {
    destroyed = true;
    unlisten?.();
    answer(null);
  });
</script>

{#snippet tiles(label: string, sources: CaptureSource[])}
  {#if sources.length}
    <section aria-label={label}>
      <h3>{label}</h3>
      <ul class="capture-grid">
        {#each sources as source (source.id)}
          <li>
            <button type="button" class="capture-tile" onclick={() => answer(source.id)}>
              <span class="capture-thumbnail">
                {#if source.thumbnail}
                  <img src={source.thumbnail} alt="" />
                {:else if source.kind === "screen"}
                  <Monitor size={28} aria-hidden="true" />
                {:else}
                  <AppWindow size={28} aria-hidden="true" />
                {/if}
              </span>
              <span class="capture-name">
                {#if source.icon}<img class="capture-icon" src={source.icon} alt="" />{/if}
                <span>{source.name}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

<Modal class="capture-picker" bind:open={() => Boolean(request), (open) => { if (!open) answer(null); }}
  title="Choose what to share" description="Select an entire screen or a single window.">
  <div class="capture-sections">
    {@render tiles("Screens", screens)}
    {@render tiles("Windows", windows)}
  </div>
  <div class="dialog-actions">
    <Button type="button" variant="outline" onclick={() => answer(null)}>Cancel</Button>
  </div>
</Modal>

<style>
  :global(.app-dialog.capture-picker) { width: min(56rem, calc(100vw - 24px)); }
  .capture-sections { display: grid; gap: 16px; margin-bottom: 16px; }
  h3 { margin-bottom: 8px; color: var(--muted-foreground); font-size: .8125rem; font-weight: 600; }
  .capture-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .capture-tile {
    display: grid;
    gap: 6px;
    width: 100%;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .capture-tile:hover { border-color: var(--ring); }
  .capture-tile:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .capture-thumbnail {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--muted);
    color: var(--muted-foreground);
  }
  .capture-thumbnail img { width: 100%; height: 100%; object-fit: contain; }
  .capture-name { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: .875rem; }
  .capture-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .capture-icon { flex: none; width: 16px; height: 16px; }
</style>
