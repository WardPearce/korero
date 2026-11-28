<script lang="ts">
  import { Check, Copy, LockKeyhole, Search, ShieldAlert, ShieldCheck, UserPlus } from "@lucide/svelte";
  import { onDestroy, onMount } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import DirectConversation from "./DirectConversation.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { directRequest, messageFrom, messageTime } from "#lib/connection/client";
  import { getIdentity } from "#lib/identity/identity";
  import { searchArchive, type ArchivedDirectMessage } from "#lib/chat/direct-archive";
  import { matchParts } from "#lib/chat/search-highlight";
  import { preferences } from "#lib/preferences";
  import { getWorkspace } from "#lib/workspace";

  type Contact = { accountId: string; displayName: string; lastMessageAt: number };
  const workspace = getWorkspace();
  const snapshot = $derived(workspace.view.snapshot!);
  let recent = $state.raw<Contact[]>([]);
  let startOpen = $state(false);
  let address = $state("");
  let query = $state("");
  let loading = $state(false);
  let inboxError = $state("");
  let addressError = $state("");
  let copyError = $state("");
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let verified = $state.raw<ReadonlySet<string>>(new Set());
  let messageQuery = $state("");
  let searchedQuery = $state("");
  let results = $state.raw<ArchivedDirectMessage[] | null>(null);
  let searchError = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchRequest = 0;
  const normalizedQuery = $derived(query.trim().toLowerCase());
  const contacts = $derived.by(() => {
    const entries = new Map(recent.map((entry) => [entry.accountId, entry]));
    const online = new Set<string>();
    for (const { accountId, displayName } of snapshot.presence) {
      if (accountId === snapshot.account.id) continue;
      online.add(accountId);
      entries.set(accountId, { accountId, displayName, lastMessageAt: entries.get(accountId)?.lastMessageAt ?? 0 });
    }
    for (const message of workspace.view.directMessages ?? []) {
      const accountId = message.senderId === snapshot.account.id ? message.recipientId : message.senderId;
      const contact = entries.get(accountId);
      if (!contact || contact.lastMessageAt < message.createdAt) {
        const senderName = message.senderId === accountId ? message.senderName : undefined;
        entries.set(accountId, { accountId, displayName: contact?.displayName ?? senderName ?? "Unknown member", lastMessageAt: message.createdAt });
      }
    }
    return [...entries.values()]
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.displayName.localeCompare(b.displayName))
      .map((entry) => ({
        ...entry,
        online: online.has(entry.accountId),
        verified: verified.has(entry.accountId),
      }));
  });
  const matches = $derived(normalizedQuery ? contacts.filter((contact) =>
    contact.displayName.toLowerCase().includes(normalizedQuery) || contact.accountId.includes(normalizedQuery)) : []);

  onMount(() => {
    void loadInbox();
    void loadVerified();
  });

  onDestroy(() => {
    if (copyTimer) clearTimeout(copyTimer);
    clearTimeout(searchTimer);
  });

  function queueSearch() {
    clearTimeout(searchTimer);
    const request = ++searchRequest;
    const query = messageQuery.trim();
    searchError = "";
    if (!query) {
      results = null;
      searchedQuery = "";
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const found = await searchArchive(workspace.serverId, snapshot.account.id, query);
        if (request !== searchRequest) return;
        results = found;
        searchedQuery = query;
      } catch (cause) {
        if (request === searchRequest) searchError = messageFrom(cause);
      }
    }, 150);
  }

  /** Cuts a long message to the text around the first match. */
  function snippet(text: string, query: string) {
    const found = Math.max(0, text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()));
    const start = Math.max(0, found - 60);
    return (start ? "…" : "") + text.slice(start, start + 240) + (start + 240 < text.length ? "…" : "");
  }

  function contactName(result: ArchivedDirectMessage) {
    return contacts.find(({ accountId }) => accountId === result.peerId)?.displayName ?? result.peerName;
  }

  async function loadInbox() {
    if (loading || !snapshot.directMessages?.persistent) return;
    inboxError = "";
    loading = true;
    try {
      recent = await directRequest<Contact[]>(snapshot.connectionId, "direct.inbox");
    } catch (cause) {
      inboxError = messageFrom(cause);
    } finally {
      loading = false;
    }
  }

  async function loadVerified() {
    try {
      const identity = await getIdentity();
      if (!identity) return;
      const prefix = "direct-safety-code:";
      const records = await preferences.local.where("key").startsWith(prefix).toArray();
      const peers = new Set<string>();
      for (const record of records) {
        try {
          const parts = JSON.parse(record.key.slice(prefix.length)) as string[];
          if (parts.length === 4 && parts[0] === workspace.serverId &&
              parts[1] === identity.publicKey && parts[2] === snapshot.account.id) peers.add(parts[3]);
        } catch {
          // Ignore unrelated local records.
        }
      }
      verified = peers;
    } catch {
      verified = new Set();
    }
  }

  async function copyOwnId(event: MouseEvent) {
    const button = event.currentTarget as HTMLButtonElement;
    copyError = "";
    try {
      await writeToClipboard(snapshot.account.id, button);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 1800);
    } catch {
      copyError = "Could not copy your account ID. Try again.";
    }
  }

  async function writeToClipboard(text: string, button: HTMLButtonElement) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Use the selection fallback when the webview denies clipboard access.
      }
    }
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    (button.closest("dialog") ?? document.body).append(field);
    field.select();
    try {
      if (!document.execCommand("copy")) throw new Error("Clipboard unavailable.");
    } finally {
      field.remove();
      button.focus();
    }
  }

  function openAccount(event: SubmitEvent) {
    event.preventDefault();
    const accountId = address.trim().toLowerCase();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(accountId) || accountId === snapshot.account.id) {
      addressError = "Enter another member’s account ID on this server.";
      return;
    }
    openConversation(accountId);
  }

  function openConversation(accountId: string) {
    if (startOpen) {
      startOpen = false;
      query = "";
      address = "";
      addressError = "";
      copyError = "";
    }
    workspace.showDirectMessages(accountId);
  }

  function back() {
    workspace.showDirectMessages();
    void loadInbox();
    void loadVerified();
  }
</script>

{#snippet person(contact: (typeof contacts)[number])}
  {@const unread = workspace.unreadDirectCounts.get(contact.accountId)}
  <li>
    <button type="button" class="tree-member dm-person" onclick={() => openConversation(contact.accountId)}>
      <Avatar name={contact.displayName} accountId={contact.accountId} small />
      <span class="dm-person-details">
        <span class="dm-person-name truncate">{contact.displayName}</span>
        <small>{contact.online ? "Online" : "Offline"}</small>
      </span>
      <span class="dm-person-statuses">
        {#if unread}<span class="dm-unread">{unread} unread</span>{/if}
        {#if contact.verified}<span class="dm-trust" title="Verified on this device"><ShieldCheck size={13} aria-hidden="true" /> Verified</span>
        {:else}<span class="dm-trust dm-trust-pending" title="Safety codes have not been compared"><ShieldAlert size={13} aria-hidden="true" /> Unverified</span>{/if}
      </span>
    </button>
  </li>
{/snippet}

{#if workspace.directAccountId}
  {#key workspace.directAccountId}
    <DirectConversation accountId={workspace.directAccountId} focus={workspace.directFocus ?? undefined} onback={back} />
  {/key}
{:else}
  <header class="workspace-header">
    <div class="heading-icon"><LockKeyhole size={18} /></div>
    <div class="flex-content">
      <div class="breadcrumb truncate">{workspace.serverTitle}</div>
      <h2>Direct messages</h2>
    </div>
  </header>
  <div class="workspace">
    {#if inboxError}<p class="form-error dm-error" role="alert">{inboxError}</p>{/if}
    <section class="dm-message-search" aria-label="Search direct messages">
      <div class="dm-search-field">
        <Search size={15} aria-hidden="true" />
        <Input class="dm-search-input" type="search" placeholder="Search your direct messages" aria-label="Search your direct messages"
          maxlength={100} spellcheck={false} autocomplete="off" bind:value={messageQuery} oninput={queueSearch} />
      </div>
      {#if searchError}<p class="form-error" role="alert">{searchError}</p>{/if}
      {#if results}
        {#if results.length}
          <ul class="dm-results" aria-label="Matching messages">
            {#each results as result (result.key)}
              {@const sender = result.senderId === snapshot.account.id ? snapshot.account.displayName : contactName(result)}
              <li>
                <button type="button" class="dm-result" onclick={() => workspace.showDirectMessages(result.peerId, result)}>
                  <Avatar name={contactName(result)} accountId={result.peerId} small />
                  <span class="dm-result-details">
                    <span class="dm-result-meta">
                      <strong class="truncate">{contactName(result)}</strong>
                      <time datetime={new Date(result.createdAt).toISOString()}>
                        {new Date(result.createdAt).toLocaleDateString()}, {messageTime.format(result.createdAt)}
                      </time>
                    </span>
                    <span class="dm-result-text">
                      {sender}:
                      {#each matchParts(result.text.length > 240 ? snippet(result.text, searchedQuery) : result.text, searchedQuery) as part, index (index)}
                        {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                      {/each}
                    </span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="dm-hint" role="status">No messages on this device match “{searchedQuery}”.</p>
        {/if}
      {:else}
        <p class="dm-hint">Searches direct messages stored on this device.</p>
      {/if}
    </section>
    <section class="dm-people" aria-labelledby="dm-people-title">
      <div class="dm-people-heading">
        <div>
          <div class="dm-people-title">
            <h3 id="dm-people-title">People</h3>
            <span class="dm-count">{contacts.length}<span class="sr-only">{contacts.length === 1 ? " person" : " people"}</span></span>
          </div>
          <p>Your conversations and online members</p>
        </div>
        <Button aria-haspopup="dialog" onclick={() => { startOpen = true; }}>
          <UserPlus size={16} aria-hidden="true" /> Start a conversation
        </Button>
      </div>
      {#if loading && !contacts.length}
        <ul class="dm-list" aria-label="Loading people">
          {#each [0, 1, 2, 3] as row (row)}<li class="dm-skeleton-row" aria-hidden="true"></li>{/each}
        </ul>
      {:else}
        <ul class="dm-list">
          {#each contacts as contact (contact.accountId)}
            {@render person(contact)}
          {:else}
            <li class="dm-empty">
              <UserPlus size={20} aria-hidden="true" />
              <p><strong>No people to show yet</strong></p>
              <p>Start a conversation using someone’s account ID.</p>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="dm-note"><LockKeyhole size={13} aria-hidden="true" /> Safety code comparison is optional and helps confirm a contact’s identity.</p>
    </section>
  </div>

  <Modal bind:open={startOpen} title="Start a conversation" description="Account IDs are specific to this server.">
    {#snippet icon()}<UserPlus size={20} aria-hidden="true" />{/snippet}
    <div class="dm-start">
      <div class="dm-search">
        <label for="dm-search">Find someone on this server</label>
        <div class="dm-search-field">
          <Search size={15} aria-hidden="true" />
          <Input id="dm-search" class="dm-search-input" placeholder="Search name or account ID"
            bind:value={query} spellcheck={false} autocomplete="off" />
        </div>
        {#if normalizedQuery}
          {#if matches.length}
            <ul class="dm-list dm-matches" aria-label="Matching people">
              {#each matches as contact (contact.accountId)}
                {@render person(contact)}
              {/each}
            </ul>
          {:else}
            <p class="dm-hint" role="status">{loading ? "Loading people…" : "No matching people."}</p>
          {/if}
        {:else}
          <p class="dm-hint">Search online members and your existing conversations.</p>
        {/if}
      </div>
      <form class="dm-form" onsubmit={openAccount}>
        <label for="dm-account-id">Add by account ID</label>
        <div class="dm-inline-form">
          <Input id="dm-account-id" required maxlength={36} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            bind:value={address} spellcheck={false} autocomplete="off" aria-invalid={Boolean(addressError)}
            aria-describedby={addressError ? "dm-address-error" : undefined} />
          <Button type="submit">Open</Button>
        </div>
        {#if addressError}<p id="dm-address-error" class="form-error" role="alert">{addressError}</p>{/if}
      </form>
      <div class="dm-share">
        <Button variant="outline" class="fit-action" onclick={copyOwnId}>
          {#if copied}<Check size={15} aria-hidden="true" />{:else}<Copy size={15} aria-hidden="true" />{/if}
          <span aria-live="polite">{copied ? "Account ID copied" : "Copy my account ID"}</span>
        </Button>
        {#if copyError}<p class="form-error" role="alert">{copyError}</p>{/if}
      </div>
    </div>
  </Modal>
{/if}

<style>
  .dm-error { flex: 0 0 auto; }
  .dm-message-search { display: grid; flex: 0 0 auto; gap: 8px; min-width: 0; }
  .dm-results {
    display: grid;
    gap: 3px;
    max-height: min(40vh, 22rem);
    padding: 4px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
  }
  .dm-result {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    text-align: left;
    cursor: pointer;
  }
  .dm-result:hover, .dm-result:focus-visible { background: var(--control-hover); }
  .dm-result:focus-visible { outline-offset: -2px; }
  .dm-result-details { display: grid; flex: 1; gap: 2px; min-width: 0; }
  .dm-result-meta { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .dm-result-meta time { flex: 0 0 auto; color: var(--muted-foreground); font-size: var(--type-caption); }
  .dm-result-text {
    display: -webkit-box;
    overflow: hidden;
    color: var(--muted-foreground);
    font-size: var(--type-small);
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .dm-result-text mark { border-radius: 2px; background: color-mix(in srgb, var(--primary) 30%, transparent); color: var(--foreground); }

  .dm-share {
    display: grid;
    gap: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .dm-start { display: grid; gap: 16px; }
  .dm-form, .dm-search { display: grid; gap: 7px; min-width: 0; }
  .dm-form label, .dm-search label { font-size: var(--type-small); font-weight: 600; }
  .dm-inline-form { display: flex; gap: 8px; min-width: 0; }
  .dm-inline-form :global([data-slot="input"]) { min-width: 0; }
  .dm-inline-form :global([data-slot="button"]) { flex: 0 0 auto; }
  .dm-hint { margin: 0; color: var(--muted-foreground); font-size: var(--type-small); line-height: 1.4; }
  .dm-search-field { position: relative; }
  .dm-search-field > :global(svg) {
    position: absolute;
    top: 50%;
    left: 10px;
    transform: translateY(-50%);
    color: var(--muted-foreground);
    pointer-events: none;
  }
  .dm-search-field :global(.dm-search-input) { padding-left: 32px; }

  .dm-people {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 240px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    box-shadow: var(--shadow-raised);
  }
  .dm-people-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
  }
  .dm-people-heading h3 { margin: 0; font-size: var(--type-body); font-weight: 600; }
  .dm-people-heading p { margin: 3px 0 0; color: var(--muted-foreground); font-size: var(--type-small); }
  .dm-people-title { display: flex; align-items: center; gap: 8px; }
  .dm-count {
    min-width: 22px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: var(--type-caption);
    text-align: center;
  }
  .dm-list { display: grid; align-content: start; gap: 3px; padding: 8px; overflow: auto; flex: 1; }
  .dm-matches {
    max-height: 12rem;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .dm-person { gap: 10px; padding: 8px 10px; min-height: 56px; cursor: pointer; }
  .dm-person:hover, .dm-person:focus-visible { background: var(--control-hover); }
  .dm-person:focus-visible { outline-offset: -2px; }
  .dm-person-details { display: grid; flex: 1; min-width: 0; gap: 1px; }
  .dm-person-name { font-weight: 600; }
  .dm-person-details small { color: var(--muted-foreground); font-size: var(--type-caption); }
  .dm-person-statuses { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px 6px; max-width: 50%; }
  .dm-unread { color: var(--primary); font-size: var(--type-caption); font-weight: 600; white-space: nowrap; }
  .dm-trust {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--success);
    font-size: var(--type-caption);
    white-space: nowrap;
  }
  .dm-trust-pending { color: var(--warning); }
  .dm-empty { display: grid; justify-items: center; gap: 4px; padding: 32px 16px; text-align: center; }
  .dm-empty :global(svg) { color: var(--info); }
  .dm-empty p { margin: 0; color: var(--muted-foreground); font-size: var(--type-small); }
  .dm-note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
    color: var(--muted-foreground);
    font-size: var(--type-small);
  }
  .dm-note :global(svg) { color: var(--info); }
  .dm-skeleton-row {
    height: 48px;
    border-radius: var(--radius-md);
    background: linear-gradient(90deg, var(--muted), color-mix(in srgb, var(--border) 55%, var(--muted)), var(--muted));
    background-size: 200% 100%;
    animation: dm-placeholder 1.2s ease-in-out infinite;
  }
  @keyframes dm-placeholder {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .dm-skeleton-row { animation: none; }
  }
</style>
