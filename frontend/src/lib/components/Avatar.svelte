<script lang="ts">
  import { Moon, UserRound } from "@lucide/svelte";
  import * as Avatar from "#lib/components/ui/avatar/index.js";
  import { initials } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";

  let { name, accountId, small = false, speaking = false, afk = false }: {
    name: string; accountId?: string; small?: boolean; speaking?: boolean; afk?: boolean;
  } = $props();
  const workspace = getWorkspace();
  const origin = $derived(workspace.serverOrigin);
  const online = $derived(workspace.view.phase === "online");
  const avatarId = $derived(accountId ? workspace.avatarId(accountId) : undefined);
  let source = $state<string>();
  let shownFor = "";

  // Keeps the current picture on screen while a new revision loads, and drops it only when the avatar
  // now belongs to someone else (another account or server) or pictures are unavailable.
  function loadPicture() {
    const owner = workspace.profilePictures && accountId && origin ? origin + "/" + accountId : "";
    if (owner !== shownFor) {
      source = undefined;
      shownFor = owner;
    }
    if (!owner || !accountId || !online) return;
    let active = true;
    void workspace.profilePicture(origin, accountId, avatarId).then((value) => {
      if (active) source = value;
    });
    return () => { active = false; };
  }
</script>

<span class={["member-avatar", { small }]} data-speaking={speaking && !afk} aria-hidden="true" {@attach loadPicture}>
  {#key source}
    <Avatar.Root size={small ? "sm" : "default"} delayMs={0}>
      {#if source}<Avatar.Image src={source} alt="" draggable={false} />{/if}
      <Avatar.Fallback>
        {#if name.trim()}{initials(name)}{:else}<UserRound size={15} aria-hidden="true" />{/if}
      </Avatar.Fallback>
    </Avatar.Root>
  {/key}
  {#if afk}<span class="avatar-afk"><Moon size={9} aria-hidden="true" /></span>{/if}
</span>
