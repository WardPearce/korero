<script lang="ts">
  import { onMount } from "svelte";
  import { apiFor, messageFrom, requestError } from "#lib/connection/client";

  let { origin, connectionId }: { origin: string; connectionId: string } = $props();
  const endpoint = $derived(apiFor(origin).connections({ id: connectionId }));
  type ConnectionDetails = Extract<Awaited<ReturnType<typeof endpoint.get>>["data"], { latencyMs: number | null }>;
  let info = $state.raw<ConnectionDetails>();
  let error = $state("");

  onMount(() => {
    let active = true;
    let pending = false;

    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const response = await endpoint.get();
        if (response.status === 404) throw new Error("Connection info is unavailable.");
        if (response.error) throw requestError(response.error);
        if (!response.data || !("latencyMs" in response.data)) throw new Error("Connection info is unavailable.");
        if (active) {
          info = response.data;
          error = "";
        }
      } catch (cause) {
        if (active) {
          info = undefined;
          error = messageFrom(cause);
        }
      } finally {
        pending = false;
      }
    }

    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  });

  function formatDuration(seconds: number) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return [hours ? `${hours}h` : "", hours || minutes ? `${minutes}m` : "", `${seconds % 60}s`].filter(Boolean).join(" ");
  }
</script>

{#if error}
  <p class="form-error" role="alert">{error}</p>
{:else if info}
  <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
    <dt class="text-muted-foreground">Member</dt>
    <dd class="wrap-break-word">{info.displayName}</dd>
    <dt class="text-muted-foreground">Channel</dt>
    <dd class="wrap-break-word">{info.channelName ?? "No channel"}</dd>
    <dt class="text-muted-foreground">Connected for</dt>
    <dd>{formatDuration(info.connectedSeconds)}</dd>
    <dt class="text-muted-foreground">Latency</dt>
    <dd>{info.latencyMs === null ? "Unavailable" : `${info.latencyMs} ms`}</dd>
  </dl>
{:else}
  <p role="status">Loading connection info…</p>
{/if}
