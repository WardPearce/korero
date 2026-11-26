<script lang="ts">
  import { Moon, UserRound } from "@lucide/svelte";
  import { Avatar } from "gridworkdesign";
  import { initials } from "./client";

  let { name, small = false, speaking = false, afk = false }: {
    name: string; small?: boolean; speaking?: boolean; afk?: boolean;
  } = $props();
</script>

<span class={["member-avatar", { small }]} data-speaking={speaking && !afk} aria-hidden="true">
  {#if name.trim()}
    <Avatar alt="" initials={initials(name)} delayMs={0} />
  {:else}
    <span class="avatar"><UserRound size={15} aria-hidden="true" /></span>
  {/if}
  {#if afk}<span class="avatar-afk"><Moon size={9} aria-hidden="true" /></span>{/if}
</span>
