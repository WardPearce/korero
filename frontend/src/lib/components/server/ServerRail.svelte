<script lang="ts">
  import { Plus, Settings2, X } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { on } from "svelte/events";
  import { asset, resolve } from "$app/paths";
  import { page } from "$app/state";
  import Avatar from "#lib/components/Avatar.svelte";
  import ContextActions from "#lib/components/ContextActions.svelte";
  import { Button } from "#lib/components/ui/button/index.js";

  type RailServer = {
    origin: string;
    name: string;
    connected: boolean;
    unread: number;
    attention?: string;
    phase?: string;
    connecting: boolean;
    focused: boolean;
    actions: { label: string; onSelect: () => void }[];
  };

  let { servers, identityReady, connectBusy, pending, username, me, online, status, onconnect, onselect, ondisconnect, onreorder }: {
    servers: RailServer[];
    identityReady: boolean;
    connectBusy: boolean;
    pending: string;
    username: string;
    me: { displayName: string; id: string } | undefined;
    online: boolean;
    status: string;
    onconnect: () => void;
    onselect: (origin: string) => void;
    ondisconnect: (origin: string) => void;
    onreorder: (source: string, target: string, after: boolean) => Promise<boolean>;
  } = $props();

  let scrollArea: HTMLDivElement;
  let list = $state<HTMLUListElement>();
  let draggedOrigin = $state<string>();
  let draggedServer = $derived(servers.find(({ origin }) => origin === draggedOrigin));
  let preview = $state.raw<{ left: number; top: number; width: number; offsetX: number; offsetY: number }>();
  let dropTarget = $state.raw<{ origin: string; after: boolean }>();
  let press: { pointerId: number; x: number; y: number; moved: boolean } | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollFrame = 0;
  let suppressClick = false;

  onDestroy(endDrag);

  function targetAt(x: number, y: number) {
    const hit = document.elementFromPoint(x, y);
    if (!list?.contains(hit)) return;
    const rows = list.querySelectorAll<HTMLElement>("[data-server-origin]");
    for (const row of rows) {
      const { top, bottom, height } = row.getBoundingClientRect();
      if (y > bottom && row.nextElementSibling) continue;
      const origin = row.dataset.serverOrigin;
      if (origin && origin !== draggedOrigin) return { origin, after: y >= top + height / 2 };
      return;
    }
  }

  function startHold(event: PointerEvent & { currentTarget: HTMLButtonElement }, origin: string) {
    if (event.button !== 0 || !event.isPrimary || press) return;
    suppressClick = false;
    if (servers.length < 2) return;
    // The server's context menu also listens for a touch hold.
    if (event.pointerType !== "mouse") event.stopPropagation();
    const button = event.currentTarget;
    const { pointerId, clientX: x, clientY: y } = event;
    press = { pointerId, x, y, moved: false };
    holdTimer = setTimeout(() => {
      const row = button.closest(".rail-server-row");
      if (!row || !button.isConnected) return endDrag();
      button.setPointerCapture(pointerId);
      const { left, top, width } = row.getBoundingClientRect();
      preview = { left, top, width, offsetX: x - left, offsetY: y - top };
      draggedOrigin = origin;
      suppressClick = true;
    }, 450);
  }

  function scrollDuringDrag() {
    scrollFrame = 0;
    if (!press) return;
    const { x, y } = press;
    const { top, bottom, left, right } = scrollArea.getBoundingClientRect();
    const previous = scrollArea.scrollTop;
    if (x >= left && x <= right && y >= top && y <= bottom) {
      if (y < top + 28) scrollArea.scrollTop -= 8;
      else if (y > bottom - 28) scrollArea.scrollTop += 8;
    }
    dropTarget = targetAt(x, y);
    if (scrollArea.scrollTop !== previous) scrollFrame = requestAnimationFrame(scrollDuringDrag);
  }

  function moveDrag(event: PointerEvent) {
    if (press?.pointerId !== event.pointerId) return;
    if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8) return;
    if (!draggedOrigin) return endDrag();
    press.moved = true;
    press.x = event.clientX;
    press.y = event.clientY;
    if (preview) preview = { ...preview, left: press.x - preview.offsetX, top: press.y - preview.offsetY };
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollDuringDrag);
  }

  function endDrag() {
    clearTimeout(holdTimer);
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    press = undefined;
    draggedOrigin = undefined;
    preview = undefined;
    dropTarget = undefined;
  }

  function cancelDrag(event: PointerEvent) {
    if (press?.pointerId === event.pointerId) endDrag();
  }

  function finishDrag(event: PointerEvent & { currentTarget: HTMLButtonElement }) {
    if (press?.pointerId !== event.pointerId) return;
    const source = draggedOrigin;
    const moved = press.moved;
    const target = source && moved ? targetAt(event.clientX, event.clientY) : undefined;
    endDrag();
    if (source && target) void onreorder(source, target.origin, target.after);
    if (source && !moved && event.pointerType !== "mouse") {
      // A stationary touch hold still gives access to the server's actions on release.
      event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY,
      }));
    }
  }

  function preventDragScroll(button: HTMLButtonElement) {
    return on(button, "touchmove", (event) => {
      if (draggedOrigin && event.touches.length === 1 && event.cancelable) event.preventDefault();
    }, { passive: false });
  }

  async function reorderWithKey(event: KeyboardEvent & { currentTarget: HTMLButtonElement }, index: number) {
    if (event.key === "Escape" && press) endDrag();
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const after = event.key === "ArrowDown";
    const neighbor = servers[index + (after ? 1 : -1)];
    const button = event.currentTarget;
    if (neighbor && await onreorder(servers[index].origin, neighbor.origin, after)) {
      await tick();
      button.focus();
    }
  }
</script>

<aside id="server-rail" class="server-rail" aria-label="Servers">
  <div class="rail-top" bind:this={scrollArea}>
    <svg class="brand" viewBox="2 0 126 29" role="img" aria-label="Kōrero.">
      <use href={asset("/korero-logo.svg") + "#wordmark"} />
    </svg>
    <Button variant="outline" class="rail-connect" disabled={!identityReady || connectBusy || Boolean(pending)} onclick={onconnect}><Plus size={18} /> Connect to server</Button>
    <section class="rail-section">
      <div class="rail-section-label"><span>Servers</span></div>
      {#if servers.length}
        <ul class="rail-server-list" bind:this={list}>
          {#each servers as entry, index (entry.origin)}
            <li class="rail-server-row" data-server-origin={entry.origin}
              data-dragging={draggedOrigin === entry.origin ? "" : undefined}
              data-drop={dropTarget?.origin === entry.origin ? (dropTarget.after ? "after" : "before") : undefined}>
              {#snippet serverButton(props: { onkeydown?: (event: KeyboardEvent) => void })}
                <button {...props} type="button" class="rail-server" aria-current={entry.focused ? "true" : undefined}
                  aria-keyshortcuts={servers.length > 1 ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                  data-reorderable={servers.length > 1 ? "" : undefined}
                  title={entry.attention || (servers.length > 1 ? "Hold and drag to reorder" : undefined)}
                  {@attach preventDragScroll}
                  onclick={(event) => {
                    if (event.detail && suppressClick) { suppressClick = false; return; }
                    onselect(entry.origin);
                  }}
                  onpointerdown={(event) => startHold(event, entry.origin)} onpointermove={moveDrag}
                  onpointerup={finishDrag} onpointercancel={cancelDrag} onlostpointercapture={cancelDrag}
                  onpointerleave={(event) => { if (!draggedOrigin) cancelDrag(event); }}
                  oncontextmenu={(event) => { if (press) event.preventDefault(); }}
                  onkeydown={(event) => { props.onkeydown?.(event); void reorderWithKey(event, index); }}>
                  <span class="shrinkable"><strong class="truncate">{entry.name}</strong>
                    {#if entry.connecting}<small role="status">Connecting…</small>
                    {:else if entry.attention}<small class="truncate">Select to connect</small>
                    {:else if entry.phase === "connecting" || entry.phase === "reconnecting"}<small>Connecting…</small>{/if}
                  </span>
                  {#if entry.unread}
                    <span class="rail-unread">{entry.unread}<span class="sr-only">{entry.unread === 1 ? " unread message" : " unread messages"}</span></span>
                  {/if}
                </button>
              {/snippet}
              <ContextActions actions={entry.actions} disabled={connectBusy || Boolean(pending)}>
                {#snippet trigger(props)}
                  {#if entry.connected}
                    <div class="active-server" data-focused={entry.focused}>
                      {@render serverButton(props)}
                      <button type="button" class="disconnect-server" aria-label={`Disconnect from ${entry.name}`} title="Disconnect"
                        disabled={connectBusy || Boolean(pending)} onclick={() => ondisconnect(entry.origin)}>
                        <X size={16} aria-hidden="true" />
                      </button>
                    </div>
                  {:else}
                    {@render serverButton(props)}
                  {/if}
                {/snippet}
              </ContextActions>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="rail-empty">No saved servers</p>
      {/if}
    </section>
  </div>
  <div class="rail-bottom">
    <div class="account-line">
      <a class="account-profile" href={resolve("/settings")} title="Account settings">
        <Avatar name={me?.displayName ?? username} accountId={me?.id} />
        <div class="flex-content">
          <strong class="truncate">{me?.displayName ?? (username || "Guest")}</strong>
          <span class="account-status"><span class="connection-dot" data-online={online}></span>{status}</span>
        </div>
      </a>

      <a class="icon-button rail-icon" href={resolve("/settings")} aria-label="Account settings" aria-current={page.route.id === "/settings" ? "page" : undefined} title="Account settings"><Settings2 size={17} /></a>
    </div>
  </div>
  {#if draggedServer && preview}
    <div class="rail-server rail-drag-preview" aria-hidden="true"
      style:left={preview.left + "px"} style:top={preview.top + "px"} style:width={preview.width + "px"}>
      <strong class="truncate">{draggedServer.name}</strong>
      {#if draggedServer.unread}
        <span class="rail-unread">{draggedServer.unread}</span>
      {/if}
    </div>
  {/if}
</aside>
