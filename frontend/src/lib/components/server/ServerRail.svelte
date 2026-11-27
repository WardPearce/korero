<script lang="ts">
  import { Plus, Settings2, X } from "@lucide/svelte";
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

  let { servers, identityReady, connectBusy, pending, username, me, online, status, onconnect, onselect, ondisconnect }: {
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
  } = $props();
</script>

<aside id="server-rail" class="server-rail" aria-label="Servers">
  <div class="rail-top">
    <svg class="brand" viewBox="2 0 126 29" role="img" aria-label="Kōrero.">
      <use href={asset("/korero-logo.svg") + "#wordmark"} />
    </svg>
    <Button variant="outline" class="rail-connect" disabled={!identityReady || connectBusy || Boolean(pending)} onclick={onconnect}><Plus size={18} /> Connect to server</Button>
    <section class="rail-section">
      <div class="rail-section-label"><span>Servers</span></div>
      {#each servers as entry (entry.origin)}
        {#snippet serverButton(props: Record<string, unknown>)}
          <button {...props} type="button" class="rail-server" aria-current={entry.focused ? "true" : undefined}
            title={entry.attention || undefined} onclick={() => onselect(entry.origin)}>
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
      {:else}
        <p class="rail-empty">No saved servers</p>
      {/each}
    </section>
  </div>
  <div class="rail-bottom">
    <div class="account-line">
      <Avatar name={me?.displayName ?? username} accountId={me?.id} />
      <div class="flex-content">
        <strong class="truncate">{me?.displayName ?? (username || "Guest")}</strong>
        <span class="account-status"><span class="connection-dot" data-online={online}></span>{status}</span>
      </div>

      <a class="icon-button rail-icon" href={resolve("/settings")} aria-label="Account settings" aria-current={page.route.id === "/settings" ? "page" : undefined} title="Account settings"><Settings2 size={17} /></a>
    </div>
  </div>
</aside>
