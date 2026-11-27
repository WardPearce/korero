<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { ArrowDownLeft, UserRound } from "@lucide/svelte";
  import { apiFor, messageFrom, requestError } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";

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
  <title>Account settings · VNX.chat</title>
</svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header">
    <div class="heading-icon"><UserRound size={19} aria-hidden="true" /></div>
    <div class="flex-content">
          <h1>Account settings</h1>
    </div>
  </header>
  <div class="workspace">
    {#if account}
      <form class="dialog-form settings-card" onsubmit={save}>
        <p class="form-status">{workspace.serverTitle}</p>
        <label>Display name<Input required maxlength={80} bind:value={accountName} /></label>
        {#if status}<p class="form-status" role="status">{status}</p>{/if}
        <div class="dialog-actions">
          <Button variant="outline" type="button" disabled={saving || Boolean(workspace.pending)} onclick={disconnect}><ArrowDownLeft size={15} /> Disconnect</Button>
          <Button type="submit" variant="default" disabled={saving || Boolean(workspace.pending)}>Save name</Button>
        </div>
      </form>
    {:else}
      <p class="notice">Connect to a server to manage your account.</p>
    {/if}
  </div>
</main>
