<script lang="ts">
  import Avatar from "#lib/components/Avatar.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
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
      await updateProfilePicture(origin, data);
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

<section class="dialog-form settings-card" aria-label="Profile picture">
  <div class="flex items-center gap-3">
    <Avatar name={account.displayName} accountId={account.id} />
    <strong>Profile picture</strong>
  </div>
  <label>
    {account.avatarId ? "Replace picture" : "Upload picture"}
    <Input type="file" accept="image/png,image/jpeg,image/webp" {disabled} onchange={choosePicture} />
  </label>
  <p class="field-hint">PNG, JPEG, or WebP up to 10 MiB. The picture is cropped to a square.</p>
  {#if account.avatarId}
    <Button type="button" variant="outline" class="fit-action" {disabled} onclick={() => save()}>Remove picture</Button>
  {/if}
  {#if saving || status}<p class="form-status" role="status">{saving ? "Saving profile picture…" : status}</p>{/if}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
</section>
