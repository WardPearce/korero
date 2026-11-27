<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Fingerprint } from "@lucide/svelte";
  import { messageFrom } from "#lib/connection/client";
  import { identityFromPrivateKey } from "#lib/identity/browser-identity";
  import { preparePrivateKey, saveLocalIdentity, type LocalProfile } from "#lib/identity/local-identity";
  import Modal from "./Modal.svelte";

  let { open, onback, oncomplete }: {
    open: boolean;
    onback: () => void;
    oncomplete: (result: LocalProfile) => void;
  } = $props();
  let username = $state("");
  let importing = $state(false);
  let file = $state<File>();
  let passphrase = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      if (importing && !file) throw new Error("Choose an identity backup.");
      const result = await saveLocalIdentity(username, async () =>
        identityFromPrivateKey(await preparePrivateKey(importing ? file : undefined, passphrase)));
      passphrase = "";
      file = undefined;
      oncomplete(result);
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }
</script>

<Modal {open} title="Set up a local identity"
  description="This device stores your private key. Export an encrypted backup from Identity settings to use your identity on another device."
  dismissible={false}>
  {#snippet icon()}<Fingerprint size={22} />{/snippet}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  <form class="dialog-form" onsubmit={submit}>
    <label>Username<Input autocomplete="nickname" required minlength={4} maxlength={32} bind:value={username} disabled={busy} /></label>
    <Checkbox label="Use an identity backup" bind:checked={importing} disabled={busy} />
    {#if importing}
      <label>Identity backup<input type="file" accept=".identity" required disabled={busy}
        onchange={(event) => { file = event.currentTarget.files?.[0]; }} /></label>
      <label>Backup passphrase<Input type="password" required minlength={12} autocomplete="off" bind:value={passphrase} disabled={busy} /></label>
    {/if}
    <div class="dialog-actions">
      <Button variant="outline" type="button" disabled={busy} onclick={onback}>Back</Button>
      <Button variant="default" type="submit" disabled={busy}>{busy ? "Saving…" : "Continue"}</Button>
    </div>
  </form>
</Modal>
