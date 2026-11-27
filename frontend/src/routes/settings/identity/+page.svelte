<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Fingerprint } from "@lucide/svelte";
  import { messageFrom } from "#lib/connection/client";
  import { downloadFile } from "#lib/download-file";
  import { exportIdentity } from "#lib/identity/identity";
  import { getWorkspace } from "#lib/workspace";

  const workspace = getWorkspace();
  const identity = $derived(workspace.identity);
  let passphrase = $state("");
  let busy = $state(false);
  let status = $state("");

  async function exportKey(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    status = "";
    try {
      const blob = await exportIdentity(passphrase);
      await downloadFile("korero.identity", new Blob([blob], { type: "text/plain" }));
      passphrase = "";
      status = "Encrypted identity exported.";
    } catch (error) {
      status = messageFrom(error);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Identity settings · Korero.chat</title></svelte:head>
<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Fingerprint size={19} aria-hidden="true" /></div><h1>Identity</h1></header>
  <div class="workspace">
    {#if identity}
      <form class="settings-card dialog-form" aria-label="Identity backup" onsubmit={exportKey}>
        <p>{identity.username} · {identity.provider ? new URL(identity.provider).host : "Local identity"}</p>
        <p>Ed25519 public key</p>
        <div class="key-display"><code>{identity.publicKey}</code></div>
        <label>Export passphrase<Input type="password" autocomplete="off" required minlength={12} bind:value={passphrase} disabled={busy} /></label>
        <Button variant="outline" class="fit-action" type="submit" disabled={busy || passphrase.length < 12}>Export encrypted identity</Button>
      </form>
      <Button variant="outline" class="fit-action" disabled={Boolean(workspace.pending)} onclick={workspace.showAccountSetup}>
        {identity.provider ? "Transfer to another provider" : "Convert to a hosted account"}
      </Button>
    {/if}
    {#if status}<p class="form-status" role="status">{status}</p>{/if}
  </div>
</main>
