<script lang="ts">
  import { ChevronDown, LockKeyhole, MessageCircle } from "@lucide/svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import type { Channel, Member } from "#lib/connection/client";

  let { channel, members, disabled = false, onjoin, onchat, onclose }: {
    channel: Channel | null;
    members: Member[];
    disabled?: boolean;
    onjoin: (channel: Channel) => void;
    onchat: (channel: Channel) => void;
    onclose: () => void;
  } = $props();

  const id = $props.id();
  let pressedBackdrop = false;

  function syncDialog(dialog: HTMLDialogElement) {
    if (channel && !dialog.open) dialog.showModal();
    if (!channel && dialog.open) dialog.close();
  }
</script>

<dialog {@attach syncDialog} class="channel-sheet" aria-labelledby={id + "-title"}
  oncancel={(event) => { event.preventDefault(); onclose(); }}
  onpointerdown={(event) => { pressedBackdrop = event.target === event.currentTarget; }}
  onclick={(event) => { if (pressedBackdrop && event.target === event.currentTarget) onclose(); }}>
  {#if channel}
    <div class="sheet-body">
      <header class="sheet-heading">
        <button type="button" class="sheet-close" aria-label="Close" onclick={onclose}>
          <ChevronDown size={20} aria-hidden="true" />
        </button>
        <h2 id={id + "-title"} class="truncate">
          {#if channel.icon}<span aria-hidden="true">{channel.icon}</span>{/if}
          {channel.name}
        </h2>
        {#if channel.passwordRequired}
          <LockKeyhole size={16} class="text-muted-foreground" aria-label="Password protected" />
        {/if}
      </header>

      {#if channel.description}<p class="sheet-description">{channel.description}</p>{/if}

      <section class="sheet-members" aria-label="People in voice">
        <h3>{members.length ? `${members.length} ${members.length === 1 ? "person" : "people"} in voice` : "No one is in voice"}</h3>
        {#if members.length}
          <ul>
            {#each members as member (member.connectionId)}
              <li>
                <Avatar name={member.displayName} accountId={member.accountId} afk={member.afk} />
                <span class="truncate">{member.displayName}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <div class="sheet-actions">
        <Button class="sheet-join" {disabled} onclick={() => onjoin(channel)}>Join voice</Button>
        <Button variant="outline" class="sheet-chat" aria-label="Open chat" title="Open chat" onclick={() => onchat(channel)}>
          <MessageCircle size={20} aria-hidden="true" />
        </Button>
      </div>
    </div>
  {/if}
</dialog>

<style>
  .channel-sheet {
    width: 100%;
    max-width: 100%;
    max-height: min(80dvh, 100dvh - var(--safe-area-inset-top, 0px) - 24px);
    margin: auto 0 0;
    padding: 0;
    border: 1px solid var(--border);
    border-bottom: 0;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow: var(--shadow-floating);
    overflow: auto;
  }
  .channel-sheet[open] { animation: sheet-in 180ms ease-out; }
  .channel-sheet::backdrop { background: var(--depth-shadow); }
  @keyframes sheet-in { from { transform: translateY(100%); } }
  @media (prefers-reduced-motion: reduce) { .channel-sheet[open] { animation: none; } }

  .sheet-body {
    display: grid;
    gap: 16px;
    padding: 12px 16px calc(16px + var(--safe-area-inset-bottom));
  }
  .sheet-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .sheet-heading h2 { flex: 1; min-width: 0; font-size: 1.125rem; font-weight: 600; }
  .sheet-close {
    display: inline-grid;
    place-items: center;
    width: var(--control-height);
    height: var(--control-height);
    flex: none;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
  }
  .sheet-close:hover { background: var(--control-hover); color: var(--foreground); }
  .sheet-description { color: var(--muted-foreground); font-size: var(--type-small); overflow-wrap: anywhere; }

  .sheet-members { display: grid; gap: 8px; }
  .sheet-members h3 { color: var(--muted-foreground); font-size: var(--type-small); }
  .sheet-members ul {
    display: grid;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    overflow: hidden;
  }
  .sheet-members li { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 8px 12px; }
  .sheet-members li + li { border-top: 1px solid var(--border); }

  .sheet-actions { display: flex; gap: 8px; }
  .sheet-actions :global(.sheet-join) { flex: 1; height: 48px; font-size: 1rem; }
  .sheet-actions :global(.sheet-chat) { width: 48px; height: 48px; padding: 0; }
</style>
