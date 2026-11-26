<script lang="ts">
  import { LockKeyhole } from "@lucide/svelte";
  import { onMount } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import DirectConversation from "./DirectConversation.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { directRequest, messageFrom } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";

  type Contact = { accountId: string; displayName: string; lastMessageAt: number };
  const workspace = getWorkspace();
  const snapshot = $derived(workspace.view.snapshot!);
  let recent = $state.raw<Contact[]>([]);
  let address = $state("");
  let loading = $state(false);
  let error = $state("");
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
    return [...entries.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.displayName.localeCompare(b.displayName))
      .map((entry) => ({ ...entry, online: online.has(entry.accountId) }));
  });

  onMount(() => { void loadInbox(); });

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
  <div class="workspace">
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    <ul class="grid gap-1">
      {#each contacts as contact (contact.accountId)}
        <li>
          <button type="button" class="tree-member member-target w-full" onclick={() => workspace.showDirectMessages(contact.accountId)}>
            <Avatar name={contact.displayName} small />
            <span class="member-details">
              <span class="truncate">{contact.displayName}</span>
              <small>{contact.online ? "Online" : "Offline"}</small>
            </span>
            {#if workspace.unreadDirectAccounts.has(contact.accountId)}<span class="ms-auto text-xs">Unread</span>{/if}
          </button>
        </li>
      {:else}
        <li class="text-muted-foreground">{loading ? "Loading conversations…" : "No conversations or other members online."}</li>
      {/each}
    </ul>
    <details class="server-motd">
      <summary>Message by account ID</summary>
      <form class="dialog-form mt-3" onsubmit={openAccount}>
        <p class="text-sm">Your account ID <code class="break-all select-all">{snapshot.account.id}</code></p>
        <label>Recipient’s account ID <Input required maxlength={36} bind:value={address} spellcheck={false} /></label>
        <Button type="submit" variant="outline">Open conversation</Button>
      </form>
    </details>
  </div>
{/if}
