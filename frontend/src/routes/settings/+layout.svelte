<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { ArrowLeft, Fingerprint, Headphones, MessageCircle, Palette, UserRound } from "@lucide/svelte";
  import VoiceToolbar from "#lib/components/media/VoiceToolbar.svelte";
  import { getWorkspace } from "#lib/workspace";
  let { children } = $props();
  const workspace = getWorkspace();
  // Stay visible when settings are showing a server other than the joined voice server.
  let connected = $derived(Boolean(workspace.activeVoice) || workspace.view.phase === "online");
  const categories = [
    { path: "/settings", label: "Account", icon: UserRound },
    { path: "/settings/appearance", label: "Appearance", icon: Palette },
    { path: "/settings/chat", label: "Chat", icon: MessageCircle },
    { path: "/settings/audio", label: "Audio", icon: Headphones },
    { path: "/settings/identity", label: "Identity", icon: Fingerprint },
  ] as const;
</script>

<div class="settings-shell" data-connected={connected || undefined}>
  {#if connected}
    <div class="settings-voice"><VoiceToolbar /></div>
  {/if}
  <nav class="settings-nav" aria-label="Settings categories">
    <a class="settings-back" href={resolve("/")}><ArrowLeft size={16} aria-hidden="true" /> Back</a>
    {#each categories as { path, label, icon: Icon } (path)}
      <a href={resolve(path)} aria-current={page.route.id === path ? "page" : undefined}><Icon size={16} aria-hidden="true" /> {label}</a>
    {/each}
  </nav>
  {@render children()}
</div>
