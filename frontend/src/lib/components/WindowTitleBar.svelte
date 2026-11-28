<script lang="ts">
  import { Copy, Minus, Square, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { isWindowMaximized, watchWindowState, windowControl } from "#lib/connection/platform";

  let maximized = $state(false);

  onMount(() => {
    void isWindowMaximized().then((value) => { maximized = value; }).catch(() => {});
    let stop: (() => void) | undefined;
    try {
      stop = watchWindowState((state) => { maximized = state.maximized; });
    } catch {
      // Not running inside the desktop bridge; the bar would not be rendered anyway.
    }
    return () => stop?.();
  });
</script>

<header class="title-bar">
  <div class="drag" aria-hidden="true"></div>
  <div class="controls">
    <button type="button" class="button" aria-label="Minimize" title="Minimize" onclick={() => windowControl("minimize")}>
      <Minus size={16} aria-hidden="true" />
    </button>
    <button type="button" class="button" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onclick={() => windowControl("maximize")}>
      {#if maximized}<Copy size={13} aria-hidden="true" />{:else}<Square size={13} aria-hidden="true" />{/if}
    </button>
    <button type="button" class="button close" aria-label="Close" title="Close" onclick={() => windowControl("close")}>
      <X size={17} aria-hidden="true" />
    </button>
  </div>
</header>

<style>
  .title-bar {
    display: flex;
    align-items: stretch;
    height: var(--titlebar-height, 38px);
    background: var(--muted);
    border-bottom: 1px solid var(--border);
    /* The whole bar is a drag handle for the frameless window. */
    -webkit-app-region: drag;
    user-select: none;
  }
  .drag {
    flex: 1;
    min-width: 0;
  }
  .controls {
    display: flex;
    align-items: stretch;
    -webkit-app-region: no-drag;
  }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    transition: background 0.1s ease, color 0.1s ease;
  }
  .button:hover {
    background: var(--control-hover);
    color: var(--foreground);
  }
  .close:hover {
    background: #e81123;
    color: #ffffff;
  }
</style>
