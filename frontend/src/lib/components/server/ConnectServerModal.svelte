<script lang="ts">
  import { ArrowRight, Cable, LockKeyhole } from "@lucide/svelte";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { shortHost, type ServerInfo } from "#lib/connection/client";

  interface CertificateContact { origin: string; fingerprint: string; publiclyTrusted: boolean }
  interface Target { origin: string; info: ServerInfo }

  let {
    open = $bindable(false),
    connectBusy,
    connectError,
    trustPrompt,
    discovery,
    accessPrompt,
    needsPassword,
    claimOwnership,
    invitationRequired,
    setupToken = $bindable(),
    serverPassword = $bindable(),
    serverCode = $bindable(),
    discoverAddress = $bindable(),
    remembered = $bindable(),
    onapprove,
    onsubmitcode,
    ondiscover,
    onreset,
    onbacktrust,
  }: {
    open?: boolean;
    connectBusy: boolean;
    connectError: string;
    trustPrompt: (CertificateContact & { previous?: string }) | null;
    discovery: Target | null;
    accessPrompt: boolean;
    needsPassword: boolean;
    claimOwnership: boolean;
    invitationRequired: boolean;
    setupToken?: string;
    serverPassword?: string;
    serverCode?: string;
    discoverAddress?: string;
    remembered?: boolean;
    onapprove: () => void;
    onsubmitcode: (event: SubmitEvent) => void;
    ondiscover: (event: SubmitEvent) => void;
    onreset: () => void;
    onbacktrust: () => void;
  } = $props();

  const title = $derived(trustPrompt ? (trustPrompt.previous ? "Server certificate changed" : "Trust this server?") : discovery ? discovery.info.name : "Connect to a server");
  const description = $derived(discovery ? shortHost(discovery.origin) : "Paste an invitation link or enter a server address.");
</script>

<Modal bind:open {title} {description} dismissible={!connectBusy}>
  {#snippet icon()}{#if discovery?.info.passwordRequired}<LockKeyhole size={21} />{:else}<Cable size={21} />{/if}{/snippet}
  {#if connectError}<p class="form-error" role="alert">{connectError}</p>{/if}
  {#if trustPrompt}
    <div class="dialog-form">
      <p>{trustPrompt.origin}</p>
      <p>Compare the certificate fingerprint with the one provided by your server operator.</p>
      {#if trustPrompt.previous}
        <div><small>Previously trusted SHA-256</small><div class="key-display"><code>{trustPrompt.previous}</code></div></div>
      {/if}
      <div><small>Presented SHA-256</small><div class="key-display"><code>{trustPrompt.fingerprint}</code></div></div>
      <div class="dialog-actions">
        <Button variant="outline" disabled={connectBusy} onclick={onbacktrust}>Back</Button>
        <Button variant="default" disabled={connectBusy} onclick={onapprove}>Trust and continue</Button>
      </div>
    </div>
  {:else if discovery && accessPrompt}
    <form class="dialog-form" onsubmit={onsubmitcode}>
      {#if discovery.info.setupRequired}
        <label>Server setup token
          <Input type="password" autocomplete="off" spellcheck="false" bind:value={setupToken} />
        </label>
        <p class="field-hint">Enter the token to claim ownership, or leave it blank to connect as a member.</p>
      {/if}
      {#if needsPassword}
        <label>Server password<Input type="password" autocomplete="current-password" required maxlength={128} bind:value={serverPassword} /></label>
      {/if}
      {#if invitationRequired && !claimOwnership}
        <label>Invitation code
          <Input type="password" required autocomplete="off" spellcheck="false" bind:value={serverCode} />
        </label>
      {/if}
      <div class="dialog-actions">
        <Button variant="outline" type="button" disabled={connectBusy} onclick={onreset}>Back</Button>
        <Button type="submit" variant="default" disabled={connectBusy}>{connectBusy ? "Connecting…" : claimOwnership ? "Set up server" : "Connect"} <ArrowRight size={16} /></Button>
      </div>
    </form>
  {:else}
    <form class="dialog-form" onsubmit={ondiscover}>
      <label>Server address or invitation link<Input required autocomplete="off" inputmode="url" placeholder="example.com:8443" spellcheck="false" disabled={connectBusy} bind:value={discoverAddress} /></label>
      <Checkbox label="Save this server address" bind:checked={remembered} />
      <Button variant="default" type="submit" disabled={connectBusy}>{connectBusy ? "Connecting…" : "Connect"} <ArrowRight size={16} /></Button>
    </form>
  {/if}
</Modal>
