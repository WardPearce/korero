<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Fingerprint, Import, KeyRound } from "@lucide/svelte";
  import { messageFrom } from "./client";
  import { generateIdentity, importIdentity } from "./identity";
  import Modal from "./Modal.svelte";
  import { saveUsername } from "./preferences";

  let { open, hasIdentity, migrationError, oncomplete }: {
    open: boolean; hasIdentity: boolean; migrationError: string; oncomplete: (username: string) => void;
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
      const name = await saveUsername(username);
      if (!hasIdentity) {
        if (importing) {
          if (!file) throw new Error("Choose an identity backup.");
          await importIdentity(file, passphrase);
        } else {
          await generateIdentity();
        }
      }
      passphrase = "";
      file = undefined;
      oncomplete(name);
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }

</script>

<Modal {open} title="Set up your identity" description="Your username will be used when you join a new VNX.chat server." dismissible={false}>
  {#snippet icon()}<Fingerprint size={22} />{/snippet}
  {#if error || migrationError}<p class="form-error" role="alert">{error || migrationError}</p>{/if}
  <form class="dialog-form" onsubmit={submit}>
    <label>Username<Input autocomplete="nickname" required bind:value={username} disabled={busy} aria-describedby="username-length" /><small id="username-length">4–32 characters</small></label>
    {#if hasIdentity}
      <Button variant="default" type="submit" disabled={busy}>Save username</Button>
    {:else if importing}
      <label>Identity backup<input type="file" accept=".identity" required disabled={busy} onchange={(event) => { file = event.currentTarget.files?.[0]; }} /></label>
      <label>Backup passphrase<Input type="password" required minlength={12} autocomplete="off" bind:value={passphrase} disabled={busy} /></label>
      <div class="dialog-actions">
        <Button variant="outline" type="button" disabled={busy} onclick={() => { importing = false; passphrase = ""; file = undefined; error = ""; }}>Back</Button>
        <Button variant="default" type="submit" disabled={busy || !file}>Import identity</Button>
      </div>
    {:else}
      <div class="identity-choices">
        <Button variant="default" type="submit" disabled={busy}><KeyRound size={18} /> Generate identity</Button>
        <Button variant="outline" type="button" disabled={busy} onclick={() => { importing = true; error = ""; }}><Import size={18} /> Import identity</Button>
      </div>
    {/if}
  </form>
</Modal>
