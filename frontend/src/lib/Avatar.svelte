<script lang="ts">
  import { UserRound } from "lucide-svelte";
  import { initials } from "./client";

  let { name, class: classes = "", speaking = false }: { name: string; class?: string; speaking?: boolean } = $props();
  let tone = $derived(Array.from(name).reduce((sum, letter) => sum + (letter.codePointAt(0) ?? 0), 0) % 4);
</script>

<span class="avatar {classes}" data-tone={tone} data-speaking={speaking} aria-hidden="true">
  {#if name}{initials(name)}{:else}<UserRound size={15} strokeWidth={1.8} />{/if}
</span>
