<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Fingerprint, Smartphone } from "@lucide/svelte";
  import { messageFrom } from "#lib/connection/client";
  import { downloadFile } from "#lib/download-file";
  import { exportIdentity } from "#lib/identity/identity";
  import { getWorkspace } from "#lib/workspace";
  import DeviceLinkExport from "#lib/components/DeviceLinkExport.svelte";

  const workspace = getWorkspace();
  const identity = $derived(workspace.identity);
  const providerHost = $derived(identity?.provider ? new URL(identity.provider).host : undefined);
  let passphrase = $state("");
  let busy = $state(false);
  let status = $state("");
  let backupError = $state("");
  let linking = $state(false);

  async function exportKey(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    status = "";
    backupError = "";
    try {
      const blob = await exportIdentity(passphrase);
      await downloadFile("korero.identity", new Blob([blob], { type: "text/plain" }));
      passphrase = "";
      status = "Encrypted identity exported.";
    } catch (error) {
      backupError = messageFrom(error);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Identity settings · Korero.chat</title></svelte:head>
<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Fingerprint size={19} aria-hidden="true" /></div><h1>Identity</h1></header>
  <div class="workspace settings-content">
    {#if identity}
      <section class="settings-card" aria-labelledby="identity-heading">
        <div class="settings-heading">
          <h2 id="identity-heading">{identity.username}</h2>
          <p class="field-hint">{providerHost ? `Hosted by ${providerHost}` : "Local identity"}</p>
        </div>
        <div class="identity-field">
          <h3>Ed25519 public key</h3>
          <div class="key-display"><code>{identity.publicKey}</code></div>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="link-heading">
        <div class="settings-row">
          <div class="settings-heading">
            <h2 id="link-heading">Link a phone</h2>
            <p class="field-hint">
              {providerHost ? "Sign in on another device without your password." : "Copy this identity and your saved servers to another device."}
              Scan a QR code, then enter the link code shown with it.
            </p>
          </div>
          <Button onclick={() => { linking = true; }}>
            <Smartphone size={16} aria-hidden="true" /> Show link code
          </Button>
        </div>
      </section>

      <form class="settings-card dialog-form" aria-labelledby="backup-heading" onsubmit={exportKey}>
        <div class="settings-heading">
          <h2 id="backup-heading">Encrypted backup</h2>
          <p class="field-hint" id="backup-hint">Download your private key, encrypted with a passphrase of at least 12 characters.</p>
        </div>
        <div class="settings-form-row">
          <label>Passphrase<Input type="password" autocomplete="off" required minlength={12} aria-describedby="backup-hint"
            bind:value={passphrase} disabled={busy} /></label>
          <Button variant="outline" type="submit" disabled={busy || passphrase.length < 12}>
            {busy ? "Exporting…" : "Export identity"}
          </Button>
        </div>
        {#if status}<p class="form-status" role="status">{status}</p>{/if}
        {#if backupError}<p class="form-error" role="alert">{backupError}</p>{/if}
      </form>

      <section class="settings-card" aria-labelledby="provider-heading">
        <div class="settings-row">
          <div class="settings-heading">
            <h2 id="provider-heading">{providerHost ? "Account provider" : "Hosted account"}</h2>
            <p class="field-hint">
              {providerHost ? "Move your identity and saved servers to a different provider."
                : "Store your encrypted identity and saved servers with a provider so you can sign in on any device."}
            </p>
          </div>
          <Button variant="outline" disabled={Boolean(workspace.pending)} onclick={workspace.showAccountSetup}>
            {providerHost ? "Transfer to another provider" : "Convert to a hosted account"}
          </Button>
        </div>
      </section>

      {#if linking}<DeviceLinkExport create={workspace.createDeviceLink} onclose={() => { linking = false; }} />{/if}
    {:else}
      <p class="notice">Sign in or create a local identity to manage device links and backups.</p>
    {/if}
  </div>
</main>

<style>
  .identity-field {
    display: grid;
    gap: 0.35rem;
  }

  .identity-field h3 {
    color: var(--muted-foreground);
    font-size: var(--type-small);
    font-weight: 500;
  }
</style>
