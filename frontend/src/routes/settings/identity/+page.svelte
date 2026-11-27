<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Fingerprint } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { messageFrom, desktopApp } from "#lib/connection/client";
  import { downloadFile } from "#lib/download-file";
  import { mobileApp } from "#lib/connection/platform";
  import { exportIdentity, generateIdentity, getIdentity, importIdentity } from "#lib/identity/identity";

  let key = $state<string | null>(null);
  let passphrase = $state("");
  let replacement = $state(false);
  let busy = $state(false);
  let status = $state("");
  const available = desktopApp() || mobileApp();

  async function run(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    status = "";
    try { await task(); } catch (error) { status = messageFrom(error); }
    finally { busy = false; }
  }

  onMount(() => {
    if (available) void run(async () => { key = (await getIdentity())?.publicKey ?? null; });
  });

  async function exportKey() {
    const blob = await exportIdentity(passphrase);
    await downloadFile("korero.identity", new Blob([blob], { type: "text/plain" }));
    passphrase = "";
    status = "Encrypted identity exported.";
  }

  function importKey(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void run(async () => {
      key = (await importIdentity(file, passphrase, replacement)).publicKey;
      passphrase = "";
      replacement = false;
      status = "Identity imported.";
    });
  }

</script>

<svelte:head><title>Identity settings · Korero.chat</title></svelte:head>
<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Fingerprint size={19} aria-hidden="true" /></div><h1>Identity</h1></header>
  <div class="workspace">
    {#if !available}<p class="notice">Open the Korero.chat desktop app to manage and back up your identity.</p>
    {:else}
      <section class="settings-card dialog-form" aria-label="Local identity">
        {#if key}
          <p>Ed25519 public key</p>
          <div class="key-display"><code>{key}</code></div>
        {:else}
          <Button variant="outline" class="fit-action" disabled={!available || busy}
            onclick={() => run(async () => { key = (await generateIdentity()).publicKey; })}>Generate identity</Button>
        {/if}
        <label>Export or import passphrase<Input type="password" autocomplete="off" minlength={12} bind:value={passphrase} /></label>
        <p class="field-hint">Use a passphrase of at least 12 characters. Keep the encrypted export and its passphrase so you can use the same server accounts on another device.</p>
        {#if key}
          <Checkbox label="Allow import to replace this device’s identity" disabled={busy} bind:checked={replacement} />
        {/if}
        <div class="identity-choices">
          <Button variant="outline" disabled={!key || busy || passphrase.length < 12} onclick={() => run(exportKey)}>Export encrypted identity</Button>
          <label class="file-control">Import identity <input type="file" accept=".identity" disabled={!available || busy || passphrase.length < 12} onchange={importKey} /></label>
        </div>
      </section>
      {#if status}<p class="form-status" role="status">{status}</p>{/if}
    {/if}
  </div>
</main>
