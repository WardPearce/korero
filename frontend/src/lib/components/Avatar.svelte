<script lang="ts">
  import { Moon, UserRound } from "@lucide/svelte";
  import * as Avatar from "#lib/components/ui/avatar/index.js";
  import { initials } from "#lib/connection/client";

  let { name, small = false, speaking = false, afk = false }: {
    name: string; small?: boolean; speaking?: boolean; afk?: boolean;
  } = $props();
</script>

<span class={["member-avatar", { small }]} data-speaking={speaking && !afk} aria-hidden="true">
  <Avatar.Root size={small ? "sm" : "default"} delayMs={0}>
    <Avatar.Fallback>
      {#if name.trim()}{initials(name)}{:else}<UserRound size={15} aria-hidden="true" />{/if}
    </Avatar.Fallback>
  </Avatar.Root>
  {#if afk}<span class="avatar-afk"><Moon size={9} aria-hidden="true" /></span>{/if}
</span>
