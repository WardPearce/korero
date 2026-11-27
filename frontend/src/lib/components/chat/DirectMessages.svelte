<script lang="ts">
  import { Check, Copy, KeyRound, LockKeyhole, Search, ShieldAlert, ShieldCheck, UserPlus } from "@lucide/svelte";
  import { onDestroy, onMount } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import DirectConversation from "./DirectConversation.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { directRequest, messageFrom } from "#lib/connection/client";
  import { getIdentity } from "#lib/identity/identity";
  import { preferences } from "#lib/preferences";
  import { getWorkspace } from "#lib/workspace";

  type Contact = { accountId: string; displayName: string; lastMessageAt: number };
  const workspace = getWorkspace();
  const snapshot = $derived(workspace.view.snapshot!);
  let recent = $state.raw<Contact[]>([]);
  let address = $state("");
  let query = $state("");
  let loading = $state(false);
  let error = $state("");
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let verified = $state.raw<ReadonlySet<string>>(new Set());
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
        entries.set(accountId, { accountId, displayName: contact?.displayName ?? accountId, lastMessageAt: message.createdAt });
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
  const visibleContacts = $derived.by(() => {
    if (!normalizedQuery) return contacts;
    return contacts.filter((contact) =>
      contact.displayName.toLowerCase().includes(normalizedQuery) || contact.accountId.includes(normalizedQuery));
  });

  onMount(() => {
    void loadInbox();
    void loadVerified();
  });

  onDestroy(() => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  async function loadInbox() {
    if (loading || !snapshot.directMessages?.persistent) return;
    error = "";
    loading = true;
    try {
      recent = await directRequest<Contact[]>(snapshot.connectionId, "direct.inbox");
    } catch (cause) {
      error = messageFrom(cause);
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

  async function copyOwnId() {
    try {
      await writeToClipboard(snapshot.account.id);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 1800);
    } catch {
      error = "Could not copy the ID. Select it and copy it manually.";
    }
  }

  async function writeToClipboard(text: string) {
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
    document.body.append(field);
    field.select();
    const copiedText = document.execCommand("copy");
    field.remove();
    if (!copiedText) throw new Error("Clipboard unavailable.");
  }

  function openAccount(event: SubmitEvent) {
    event.preventDefault();
    const accountId = address.trim().toLowerCase();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(accountId) || accountId === snapshot.account.id) {
      error = "Enter another member’s account ID on this server.";
      return;
    }
    error = "";
    address = "";
    workspace.showDirectMessages(accountId);
  }

  function back() {
    workspace.showDirectMessages();
    void loadInbox();
    void loadVerified();
  }
</script>

{#if workspace.directAccountId}
  {#key workspace.directAccountId}
    <DirectConversation accountId={workspace.directAccountId} onback={back} />
  {/key}
{:else}
  <header class="workspace-header">
    <div class="heading-icon"><LockKeyhole size={18} /></div>
    <div class="flex-content">
      <div class="breadcrumb truncate">{workspace.serverTitle}</div>
      <h2>Direct messages</h2>
    </div>
  </header>
  <div class="workspace dm-desk">
    {#if error}<p class="form-error dm-error" role="alert">{error}</p>{/if}

    <div class="dm-columns">
      <section class="dm-people" aria-labelledby="dm-people-title">
        <div class="dm-people-heading">
          <div>
            <h3 id="dm-people-title">{normalizedQuery ? "Matching people" : "People"}</h3>
            <p>{normalizedQuery ? "People matching your search" : "Your conversations and online members"}</p>
          </div>
          <span class="dm-count">{visibleContacts.length}</span>
        </div>
        {#if loading}
          <ul class="dm-list" aria-label="Loading people">
            {#each [0, 1, 2, 3] as row (row)}<li class="dm-skeleton-row" aria-hidden="true"></li>{/each}
          </ul>
        {:else}
          <ul class="dm-list">
            {#each visibleContacts as contact (contact.accountId)}
              <li>
                <button type="button" class="tree-member member-target dm-person"
                  onclick={() => workspace.showDirectMessages(contact.accountId)}>
                  <Avatar name={contact.displayName} small />
                  <span class="member-details dm-person-details">
                    <span class="dm-person-name truncate">{contact.displayName}</span>
                    <small>{contact.online ? "Online" : "Offline"} · {contact.accountId.slice(0, 8)}…</small>
                  </span>
                  <span class="dm-person-statuses">
                    {#if workspace.unreadDirectAccounts.has(contact.accountId)}<span class="dm-unread">Unread</span>{/if}
                    {#if contact.verified}<span class="dm-trust" title="Verified on this device"><ShieldCheck size={13} aria-hidden="true" /> Verified</span>
                    {:else}<span class="dm-trust dm-trust-pending" title="Safety codes have not been compared"><ShieldAlert size={13} aria-hidden="true" /> Unverified</span>{/if}
                  </span>
                </button>
              </li>
            {:else}
              <li class="dm-empty">
                <Search size={20} aria-hidden="true" />
                {#if normalizedQuery}<p>No people match “{query.trim()}”.</p><p>Try a name, an account ID, or add someone by ID.</p>
                {:else}<p>No conversations yet</p><p>Search for someone online or add them using their account ID.</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
        <p class="dm-note"><LockKeyhole size={13} aria-hidden="true" /> Safety code comparison is optional and helps confirm a contact’s identity.</p>
      </section>

      <section class="dm-start" aria-labelledby="dm-start-title">
        <div class="dm-section-heading">
          <UserPlus size={16} aria-hidden="true" />
          <h3 id="dm-start-title">Start a conversation</h3>
        </div>
        <section class="dm-identity" aria-labelledby="dm-identity-title">
          <div class="dm-identity-icon"><KeyRound size={18} aria-hidden="true" /></div>
          <div class="dm-identity-copy">
            <h4 id="dm-identity-title">Your account ID</h4>
            <p>Share this with someone on this server so they can message you.</p>
          </div>
          <code class="dm-identity-id font-mono">{snapshot.account.id}</code>
          <Button type="button" variant="outline" class="dm-copy w-full" onclick={copyOwnId}>
            {#if copied}<Check size={15} aria-hidden="true" /> Copied{:else}<Copy size={15} aria-hidden="true" /> Copy ID{/if}
          </Button>
        </section>
        <form class="dm-form" onsubmit={openAccount}>
          <label for="dm-account-id">Add by account ID</label>
          <div class="dm-inline-form">
            <Input id="dm-account-id" required maxlength={36} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              bind:value={address} spellcheck={false} autocomplete="off" />
            <Button type="submit">Open</Button>
          </div>
          <p class="dm-hint">Paste the full ID from the person you want to message.</p>
        </form>
        <div class="dm-divider" role="separator"></div>
        <div class="dm-search">
          <label for="dm-search">Find someone on this server</label>
          <div class="dm-search-field">
            <Search size={15} aria-hidden="true" />
            <Input id="dm-search" class="dm-search-input" placeholder="Search name or account ID"
              bind:value={query} spellcheck={false} autocomplete="off" />
          </div>
          <p class="dm-hint">Searches online members and conversations saved on this device.</p>
        </div>
      </section>

    </div>
  </div>
{/if}

<style>
  .dm-desk {
    display: flex;
    flex-direction: column;
    gap: var(--ui-gap);
  }
  .dm-error { flex: 0 0 auto; }

  .dm-identity {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 8px 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--muted);
    box-shadow: var(--shadow-inset);
  }
  .dm-identity-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--primary);
  }
  .dm-identity-copy { min-width: 0; }
  .dm-identity-copy h4 { margin: 0; font-size: var(--type-small); font-weight: 600; }
  .dm-identity-copy p { margin: 2px 0 0; color: var(--muted-foreground); font-size: var(--type-caption); line-height: 1.4; }
  .dm-identity-id {
    grid-column: 1 / -1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
    box-shadow: var(--shadow-inset);
    font-size: var(--type-small);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .dm-identity :global(.dm-copy) { grid-column: 1 / -1; white-space: nowrap; }

  .dm-columns {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    align-items: stretch;
    gap: var(--ui-gap);
    flex: 1;
    min-height: 0;
  }
  .dm-start, .dm-people {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    box-shadow: var(--shadow-raised);
  }
  .dm-start { display: grid; align-content: start; gap: 16px; padding: 18px; }
  .dm-section-heading { display: flex; align-items: center; gap: 8px; }
  .dm-section-heading :global(svg) { color: var(--primary); }
  .dm-section-heading h3 { margin: 0; font-size: var(--type-body); font-weight: 600; }
  .dm-form, .dm-search { display: grid; gap: 7px; min-width: 0; }
  .dm-form label, .dm-search label { font-size: var(--type-small); font-weight: 600; }
  .dm-inline-form { display: flex; gap: 8px; min-width: 0; }
  .dm-inline-form :global([data-slot="input"]) { min-width: 0; }
  .dm-inline-form :global([data-slot="button"]) { flex: 0 0 auto; }
  .dm-hint { margin: 0; color: var(--muted-foreground); font-size: var(--type-small); line-height: 1.4; }
  .dm-divider { height: 1px; background: var(--border); }
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

  .dm-people { display: flex; flex-direction: column; overflow: hidden; min-height: 320px; }
  .dm-people-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
  }
  .dm-people-heading h3 { margin: 0; font-size: var(--type-body); font-weight: 600; }
  .dm-people-heading p { margin: 3px 0 0; color: var(--muted-foreground); font-size: var(--type-small); }
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
  .dm-list { display: grid; align-content: start; gap: 3px; padding: 10px; overflow: auto; flex: 1; }
  .dm-person { gap: 12px; padding: 12px; min-height: 64px; }
  .dm-person:hover, .dm-person:focus-visible { background: var(--muted); }
  .dm-person-details { display: grid; gap: 1px; }
  .dm-person-name { font-weight: 600; }
  .dm-person-details small { color: var(--muted-foreground); font-size: var(--type-caption); }
  .dm-person-statuses { display: flex; align-items: center; gap: 6px; margin-left: auto; }
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

  @media (max-width: 900px) {
    .dm-columns { grid-template-columns: minmax(0, 1fr); }
    .dm-start { order: 2; }
    .dm-people { order: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dm-skeleton-row { animation: none; }
  }
</style>
