<script lang="ts">
  import { HeadphoneOff, MicOff } from "@lucide/svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import type { VoiceState } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";

  let { origin, view }: { origin: string; view: VoiceState } = $props();

  const maxShown = 4;
  const workspace = getWorkspace();
  const snapshot = $derived(view.snapshot);
  const channel = $derived(snapshot?.channels.find(({ id }) => id === snapshot.channelId));
  const members = $derived(snapshot?.members ?? []);
  const own = $derived(members.find(({ connectionId }) => connectionId === snapshot?.connectionId));
  const speakers = $derived(members.filter((member) =>
    !member.afk && (member.speaking ?? view.speaking.includes(member.connectionId))));
  // Profile pictures are cached for the focused server only; other servers show initials.
  const pictures = $derived(origin === workspace.serverOrigin);
</script>

<div class="call-pip" role="status" aria-live="polite">
  <header>
    <span class="call-pip-channel">{channel?.name ?? "Voice"}</span>
    {#if own?.deafened || own?.adminDeafened}
      <HeadphoneOff size={14} aria-label="Deafened" />
    {:else if own?.muted || own?.adminMuted}
      <MicOff size={14} aria-label="Muted" />
    {/if}
  </header>
  {#if speakers.length}
    <ul class="call-pip-speakers" data-count={Math.min(speakers.length, maxShown)}>
      {#each speakers.slice(0, maxShown) as member (member.connectionId)}
        <li>
          <Avatar name={member.displayName} accountId={pictures ? member.accountId : undefined} speaking />
          <span>{member.connectionId === snapshot?.connectionId ? "You" : member.displayName}</span>
        </li>
      {/each}
      {#if speakers.length > maxShown}<li class="call-pip-more">+{speakers.length - maxShown}</li>{/if}
    </ul>
  {:else}
    <p class="call-pip-quiet">{members.length === 1 ? "Only you here" : `${members.length} in channel`}</p>
  {/if}
</div>
