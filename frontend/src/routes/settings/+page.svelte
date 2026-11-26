<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import SelectField from "#lib/components/SelectField.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import { resolve } from "$app/paths";
  import { ArrowDownLeft, ArrowLeft, Settings2 } from "@lucide/svelte";
  import { apiFor, messageFrom, requestError } from "#lib/client";
  import { readTheme, saveTheme, themeOptions } from "#lib/theme";
  import { getWorkspace } from "#lib/workspace";

  const workspace = getWorkspace();
  let theme = $state(readTheme());

  function changeTheme(value: typeof theme) {
    if (theme === value) return;
    theme = value;
    saveTheme(value);
  }
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
    <div class="heading-icon"><Settings2 size={23} /></div>
    <div class="flex-content">
      <div class="breadcrumb">VNX.chat / Settings</div>
      <h1>Account settings</h1>
    </div>
    <a class="icon-button" href={resolve("/")} aria-label="Back to workspace" title="Back to workspace"><ArrowLeft size={18} /></a>
  </header>
  <div class="workspace">
    {#if account}
      <form class="dialog-form account-settings" onsubmit={save}>
        <p class="form-status">{workspace.serverTitle}</p>
        <label>Display name<Input required maxlength={80} bind:value={accountName} /></label>
        {#if status}<p class="form-status" role="status">{status}</p>{/if}
        <div class="dialog-actions">
          <Button variant="outline" type="button" disabled={saving || Boolean(workspace.pending)} onclick={disconnect}><ArrowDownLeft size={15} /> Disconnect</Button>
          <Button type="submit" variant="default" disabled={saving || Boolean(workspace.pending)}>Save name</Button>
        </div>
      </form>
    {:else}
      <p>Connect to a server to manage your account.</p>
    {/if}
    <Card.Root class="appearance-card">
      <Card.Header><Card.Title><h2>Appearance</h2></Card.Title></Card.Header>
      <Card.Content>
        <SelectField label="Theme" options={themeOptions} bind:value={() => theme, changeTheme} />
      </Card.Content>
    </Card.Root>
  </div>
</main>
