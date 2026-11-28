<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Fingerprint } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { messageFrom } from "#lib/connection/client";
  import { defaultAccountProvider, HostedAccount } from "#lib/identity/hosted-account";
  import { preparePrivateKey } from "#lib/identity/local-identity";
  import { readAppearance } from "#lib/theme";
  import Modal from "./Modal.svelte";

  type AccountResult = Awaited<ReturnType<typeof HostedAccount.open>>;
  let { open, migration, onlocal, onlink, oncomplete }: {
    open: boolean;
    migration?: { username: string; origin?: string; submit: (provider: string, username: string, password: string) => Promise<AccountResult> };
    onlocal: () => Promise<void>;
    onlink?: () => void;
    oncomplete: (result: AccountResult) => void;
  } = $props();
  let provider = $state(defaultAccountProvider);
  let username = $state("");
  let password = $state("");
  let creating = $state(false);
  let importing = $state(false);
  let file = $state<File>();
  let passphrase = $state("");
  let busy = $state(false);
  let error = $state("");
  let registering = $derived(creating || Boolean(migration));

  untrack(() => {
    if (migration) {
      username = migration.username;
      if (migration.origin) provider = "";
    }
  });

  function toggleMode() {
    creating = !creating;
    password = "";
    error = "";
  }

  async function createPrivateKey() {
    if (importing && !file) throw new Error("Choose an identity backup.");
    return preparePrivateKey(importing ? file : undefined, passphrase);
  }

  async function continueLocally() {
    busy = true;
    error = "";
    password = "";
    passphrase = "";
    try { await onlocal(); }
    catch (cause) { error = messageFrom(cause); }
    finally { busy = false; }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      const result = migration ? await migration.submit(provider, username, password)
        : await HostedAccount.open(provider, username, password,
          creating ? { privateKey: createPrivateKey, servers: [], appearance: readAppearance() } : undefined);
      password = "";
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

<Modal {open} title={migration ? (migration.origin ? "Transfer to another provider" : "Convert to a hosted account")
    : creating ? "Create your account" : "Sign in to Korero.chat"}
  description={migration ? "Create an account with your chosen provider to carry over your identity, server bookmarks and themes."
    : "Sign in on any device to restore your encrypted identity, server bookmarks, saved server passwords and themes."}
  dismissible={false}>
  {#snippet icon()}<Fingerprint size={22} />{/snippet}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  <form class="dialog-form" onsubmit={submit}>
    <label>{migration?.origin ? "New account provider" : "Account provider"}<Input required spellcheck="false" autocomplete="off" autocapitalize="off" inputmode="url"
      bind:value={provider} disabled={busy} placeholder={defaultAccountProvider} /></label>
    <label>Username<Input autocomplete="username" required spellcheck="false" autocapitalize="off" maxlength={32}
      bind:value={username} disabled={busy} /></label>
    <label>Password<Input type="password" required minlength={12} maxlength={256}
      autocomplete={registering ? "new-password" : "current-password"} bind:value={password} disabled={busy} /></label>
    {#if creating}
      <Checkbox label="Use an identity backup" bind:checked={importing} disabled={busy} />
      {#if importing}
        <label>Identity backup<input type="file" accept=".identity" required disabled={busy}
          onchange={(event) => { file = event.currentTarget.files?.[0]; }} /></label>
        <label>Backup passphrase<Input type="password" required minlength={12} autocomplete="off" bind:value={passphrase} disabled={busy} /></label>
      {/if}
    {/if}
    <div class="dialog-actions">
      <Button variant="outline" type="button" disabled={busy} onclick={migration ? continueLocally : toggleMode}>
        {migration ? "Cancel" : creating ? "Back to sign in" : "Create account"}
      </Button>
      <Button variant="default" type="submit" disabled={busy}>
        {migration?.origin ? (busy ? "Transferring…" : "Transfer identity")
          : registering ? (busy ? "Creating…" : "Create account") : (busy ? "Signing in…" : "Sign in")}
      </Button>
    </div>
  </form>
  {#if !migration}
    <div class="local-option">
      <Button variant="outline" class="w-full" type="button" disabled={busy} onclick={continueLocally}
        aria-describedby="local-identity-hint">Continue without an account</Button>
      <p id="local-identity-hint" class="field-hint">Your private key is stored on this device.</p>
      {#if onlink}
        <Button variant="outline" class="w-full" type="button" disabled={busy} onclick={onlink}>Link from another device</Button>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .local-option {
    display: grid;
    gap: 0.5rem;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    text-align: center;
  }
</style>
