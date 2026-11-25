<script lang="ts">
  import { Moon, UserRound } from "lucide-svelte";
  import { initials } from "./client";

  let { name, class: classes = "", speaking = false, afk = false }: {
    name: string; class?: string; speaking?: boolean; afk?: boolean;
  } = $props();
  let tone = $derived(Array.from(name).reduce((sum, letter) => sum + (letter.codePointAt(0) ?? 0), 0) % 4);
</script>

<span class="avatar {classes}" data-tone={tone} data-speaking={speaking && !afk} data-afk={afk} aria-hidden="true">
  {#if name}{initials(name)}{:else}<UserRound size={15} strokeWidth={1.8} />{/if}
  {#if afk}<span class="avatar-afk"><Moon size={8} strokeWidth={2.8} /></span>{/if}
</span>

<style>
  .avatar[data-afk="true"] { position: relative; }
  .avatar-afk {
    position: absolute;
    right: -3px;
    bottom: -3px;
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border: 2px solid var(--paper);
    border-radius: 50%;
    background: var(--afk);
    color: var(--rail);
  }
</style>
