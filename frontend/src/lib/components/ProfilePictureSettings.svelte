<script lang="ts">
  import Avatar from "#lib/components/Avatar.svelte";
  import { Upload } from "@lucide/svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { messageFrom, type Account } from "#lib/connection/client";
  import { encodeProfilePicture, updateProfilePicture } from "#lib/identity/profile-picture";
  import { getWorkspace } from "#lib/workspace";

  let { account }: { account: Account } = $props();
  const workspace = getWorkspace();
  let saving = $state(false);
  let status = $state("");
  let error = $state("");
  const disabled = $derived(saving || Boolean(workspace.pending) || workspace.view.phase !== "online");

  async function save(file?: File) {
    const origin = workspace.serverOrigin;
    const connectionId = workspace.view.snapshot?.connectionId;
    if (disabled || !origin || !connectionId) return;
    saving = true;
    status = "";
    error = "";
    try {
      const data = file ? await encodeProfilePicture(file) : null;
      if (workspace.serverOrigin !== origin || workspace.view.snapshot?.connectionId !== connectionId) return;
      const avatarId = await updateProfilePicture(origin, data);
      workspace.cacheProfilePicture(origin, account.id, avatarId, data);
      status = file ? "Profile picture updated." : "Profile picture removed.";
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      saving = false;
    }
  }

  function choosePicture(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void save(file);
  }
</script>

<section class="settings-card" aria-labelledby="profile-picture-heading">
  <div class="settings-row">
    <div class="picture-heading">
      <Avatar name={account.displayName} accountId={account.id} />
      <div class="settings-heading">
        <h2 id="profile-picture-heading">Profile picture</h2>
        <p class="field-hint" id="profile-picture-hint">PNG, JPEG, or WebP up to 10 MiB. Pictures are cropped to a square.</p>
      </div>
    </div>
    <div class="picture-actions">
      <label class="file-control">
        <Upload size={16} aria-hidden="true" /> {account.avatarId ? "Replace picture" : "Upload picture"}
        <input type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="profile-picture-hint" {disabled} onchange={choosePicture} />
      </label>
      {#if account.avatarId}
        <Button variant="outline" {disabled} onclick={() => save()}>Remove picture</Button>
      {/if}
    </div>
  </div>
  {#if saving || status}<p class="form-status" role="status">{saving ? "Saving profile picture…" : status}</p>{/if}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
</section>

<style>
  .picture-heading { display: flex; flex: 1 1 16rem; align-items: center; min-width: 0; gap: .75rem; }
  .picture-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .file-control {
    gap: .375rem;
    padding: .25rem .625rem;
    border-color: var(--input);
    border-radius: var(--radius-lg);
    background: var(--background);
    font-size: var(--type-small);
  }
</style>
