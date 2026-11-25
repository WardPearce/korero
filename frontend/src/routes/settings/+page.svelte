<script lang="ts">
  import { resolve } from "$app/paths";
  import { ArrowDownLeft, ArrowLeft, Settings2 } from "lucide-svelte";
  import { apiFor, messageFrom, requestError } from "$lib/client";
  import { getWorkspace } from "$lib/workspace";

  const workspace = getWorkspace();
  let account = $derived(workspace.view.snapshot?.account);
  let accountName = $derived(account?.displayName ?? "");
  let status = $state("");
  let saving = $state(false);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!workspace.serverOrigin || saving || workspace.pending) return;
    saving = true;
    status = "";
    try {
      const result = await apiFor(workspace.serverOrigin).account.patch({ displayName: accountName.trim() });
      if (result.error) throw requestError(result.error);
      status = "Display name updated.";
    } catch (error) {
      status = messageFrom(error);
    } finally {
      saving = false;
    }
  }

  async function disconnect() {
    if (!await workspace.disconnect()) status = workspace.actionError;
  }
</script>

<svelte:head>
  <title>Account settings · Kōrero</title>
</svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header">
    <div class="heading-icon"><Settings2 size={23} /></div>
    <div class="min-w-0 grow">
      <div class="breadcrumb">Kōrero<span></span>Settings</div>
      <h1>Account settings</h1>
    </div>
    <a class="icon-button" href={resolve("/")} aria-label="Back to workspace" title="Back to workspace"><ArrowLeft size={18} /></a>
  </header>
  <div class="workspace">
    {#if account}
      <form class="dialog-form account-settings" onsubmit={save}>
        <p class="form-status">{workspace.serverTitle}</p>
        <label>Display name<input required maxlength={80} bind:value={accountName} /></label>
        {#if status}<p class="form-status" role="status">{status}</p>{/if}
        <div class="dialog-actions">
          <button type="button" class="secondary-button" disabled={saving || Boolean(workspace.pending)} onclick={disconnect}><ArrowDownLeft size={15} /> Disconnect</button>
          <button type="submit" class="primary-button" disabled={saving || Boolean(workspace.pending)}>Save name</button>
        </div>
      </form>
    {:else}
      <p>Connect to a server to manage your account.</p>
    {/if}
  </div>
</main>
