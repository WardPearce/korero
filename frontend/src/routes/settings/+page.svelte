<script lang="ts">
  import ProfilePictureSettings from "#lib/components/ProfilePictureSettings.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { ArrowDownLeft, LogOut, UserRound } from "@lucide/svelte";
  import { apiFor, messageFrom, requestError } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";

  const workspace = getWorkspace();
  let account = $derived(workspace.view.snapshot?.account);
  let accountName = $derived(account?.displayName ?? "");
  let status = $state("");
  let profileError = $state("");
  let signOutError = $state("");
  let saving = $state(false);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!workspace.serverOrigin || saving || workspace.pending) return;
    saving = true;
    status = "";
    profileError = "";
    try {
      const result = await apiFor(workspace.serverOrigin).account.patch({ displayName: accountName.trim() });
      if (result.error) throw requestError(result.error);
      status = "Display name updated.";
    } catch (error) {
      profileError = messageFrom(error);
    } finally {
      saving = false;
    }
  }

  async function disconnect() {
    status = "";
    profileError = "";
    if (!await workspace.disconnect()) profileError = workspace.actionError;
  }

  async function signOut() {
    signOutError = "";
    if (!await workspace.signOut()) signOutError = workspace.actionError;
  }
</script>

<svelte:head>
  <title>Account settings · Korero.chat</title>
</svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header">
    <div class="heading-icon"><UserRound size={19} aria-hidden="true" /></div>
    <h1>Account</h1>
  </header>
  <div class="workspace settings-content">
    {#if workspace.identity?.provider}
      <section class="settings-card" aria-labelledby="hosted-account-heading">
        <div class="settings-row">
          <div class="settings-heading">
            <h2 id="hosted-account-heading">Hosted account</h2>
            <p class="field-hint">{workspace.identity.username} · {new URL(workspace.identity.provider).host}</p>
          </div>
          <Button variant="outline" disabled={Boolean(workspace.pending)} onclick={signOut}>
            <LogOut size={16} aria-hidden="true" /> Sign out
          </Button>
        </div>
        {#if signOutError}<p class="form-error" role="alert">{signOutError}</p>{/if}
      </section>
    {/if}
    {#if account}
      <form class="dialog-form settings-card" aria-labelledby="server-profile-heading" onsubmit={save}>
        <div class="settings-row">
          <div class="settings-heading">
            <h2 id="server-profile-heading">Server profile</h2>
            <p class="field-hint">{workspace.serverTitle}</p>
          </div>
          <Button variant="outline" disabled={saving || Boolean(workspace.pending)} onclick={disconnect}>
            <ArrowDownLeft size={15} aria-hidden="true" /> Disconnect
          </Button>
        </div>
        <div class="settings-form-row">
          <label>Display name<Input required maxlength={80} bind:value={accountName} /></label>
          <Button type="submit" disabled={saving || Boolean(workspace.pending) || !accountName.trim()}>{saving ? "Saving…" : "Save name"}</Button>
        </div>
        {#if status}<p class="form-status" role="status">{status}</p>{/if}
        {#if profileError}<p class="form-error" role="alert">{profileError}</p>{/if}
      </form>
      {#if workspace.profilePictures}
        {#key workspace.view.snapshot?.connectionId}<ProfilePictureSettings {account} />{/key}
      {/if}
    {:else}
      <p class="notice">Connect to a voice server to edit your profile there.</p>
    {/if}
  </div>
</main>
