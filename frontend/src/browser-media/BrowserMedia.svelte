<script lang="ts">
  import { onMount } from "svelte";
  import ScreenSharing from "#lib/components/media/ScreenSharing.svelte";
  import { messageFrom, type Snapshot } from "#lib/connection/client";
  import { supportsWebRtc, type VideoSource } from "#lib/media/screen-media";

  let snapshot = $state.raw<Snapshot>();
  let controls = $state<HTMLDivElement>();
  let source = $state<VideoSource>("screen");
  let initialSetup = $state(false);
  let error = $state("");
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);

  async function request<T>(kind: string, payload: Record<string, unknown> = {}, keepalive = false): Promise<T> {
    const response = await fetch("/rpc", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ kind, payload }), keepalive,
      signal: keepalive ? undefined : AbortSignal.timeout(12000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The desktop connection ended.");
    return body as T;
  }

  onMount(() => {
    if (!supportsWebRtc()) {
      error = "Open the video link in a browser with WebRTC support.";
      return;
    }
    if (!token) {
      error = "Open the video controls from the VNX.chat desktop app.";
      return;
    }
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const state = await request<{ snapshot: Snapshot; source: VideoSource; share: boolean }>("state");
        if (!mounted) return;
        source = state.source;
        initialSetup = state.share;
        snapshot = state.snapshot;
        timer = setTimeout(refresh, 3000);
      } catch (failure) {
        if (!mounted) return;
        snapshot = undefined;
        error = messageFrom(failure);
      }
    }
    void refresh();
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  });

  function disconnect() {
    if (token) void request("close", {}, true).catch(() => {});
  }
</script>

<svelte:window onpagehide={disconnect} />
<main class="media-window">
  <header>
    <h1>{source === "camera" ? "VNX.chat camera" : "VNX.chat screenshare"}</h1>
    {#if snapshot}
      <p>{snapshot.channels.find(({ id }) => id === snapshot?.channelId)?.name ?? "Voice channel"}</p>
      <p>Keep the desktop app connected while using this tab.</p>
    {/if}
  </header>
  <div class="media-controls" bind:this={controls}></div>
  {#if snapshot && controls}
    <ScreenSharing {snapshot} {source} {initialSetup} relay={request} visible controlsTarget={controls} />
  {:else if error}
    <p class="form-error" role="alert">{error}</p>
  {:else}
    <p role="status">Connecting to VNX.chat…</p>
  {/if}
</main>

<style>
  .media-window { width: min(100%, 68rem); margin-inline: auto; padding: max(16px, var(--ui-gap)); }
  header { border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px; }
  h1 { font-size: 1.25rem; font-weight: 650; }
  header p { color: var(--muted-foreground); }
  .media-controls { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
