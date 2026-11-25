<script lang="ts">
  import { Fingerprint } from "lucide-svelte";
  import { onMount } from "svelte";
  import { messageFrom, nativeApp } from "$lib/client";
  import { exportIdentity, generateIdentity, getIdentity, importIdentity } from "$lib/identity";

  let key = $state<string | null>(null);
  let passphrase = $state("");
  let replacement = $state(false);
  let busy = $state(false);
  let status = $state("");
  const available = nativeApp();

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
    const url = URL.createObjectURL(new Blob([blob], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "korero.identity";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

<svelte:head><title>Identity settings · Kōrero</title></svelte:head>
<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Fingerprint size={19} /></div><h1>Identity</h1></header>
  <div class="workspace">
    {#if !available}<p>Identity management is available in the desktop app.</p>{/if}
    <section class="settings-card dialog-form" aria-label="Local identity">
      {#if key}
        <p>Ed25519 public key</p>
        <div class="key-display"><code>{key}</code></div>
      {:else}
        <button class="secondary-button w-fit" disabled={!available || busy}
          onclick={() => run(async () => { key = (await generateIdentity()).publicKey; })}>Generate identity</button>
      {/if}
      <label>Export or import passphrase<input type="password" autocomplete="off" minlength={12} bind:value={passphrase} /></label>
      <p class="text-sm text-(--muted)">Use a passphrase of at least 12 characters. Keep the encrypted export and its passphrase so you can use the same server accounts on another device.</p>
      {#if key}<label class="checkbox-label"><input type="checkbox" bind:checked={replacement} /> Allow import to replace this device’s identity</label>{/if}
      <div class="flex flex-wrap gap-2">
        <button class="secondary-button" disabled={!key || busy || passphrase.length < 12} onclick={() => run(exportKey)}>Export encrypted identity</button>
        <label class="secondary-button file-control">Import identity <input type="file" accept=".identity" disabled={!available || busy || passphrase.length < 12} onchange={importKey} /></label>
      </div>
    </section>
    {#if status}<p class="form-status" role="status">{status}</p>{/if}
  </div>
</main>
