<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { ArrowLeft, Fingerprint, Headphones, UserRound } from "lucide-svelte";
  let { children } = $props();
  const categories = [
    { path: "/settings", label: "Account", icon: UserRound },
    { path: "/settings/audio", label: "Audio", icon: Headphones },
    { path: "/settings/identity", label: "Identity", icon: Fingerprint },
  ] as const;
</script>

<div class="settings-shell">
  <nav class="settings-nav" aria-label="Settings categories">
    <a href={resolve("/")}><ArrowLeft size={16} /> Workspace</a>
    {#each categories as { path, label, icon: Icon } (path)}
      <a href={resolve(path)} aria-current={page.route.id === path ? "page" : undefined}><Icon size={16} /> {label}</a>
    {/each}
  </nav>
  {@render children()}
</div>
