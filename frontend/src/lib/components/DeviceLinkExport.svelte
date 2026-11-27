<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { messageFrom } from "#lib/connection/client";
  import type { DeviceLink } from "#lib/identity/device-link";
  import SvgQR from "@svelte-put/qr/svg/QR.svelte";
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";

  // Mount only while the dialog is shown, so a fresh link and code are created each time
  // and both are discarded when it closes.
  let { create, onclose }: { create: () => Promise<DeviceLink>; onclose: () => void } = $props();
  let open = $state(true);
  const link = untrack(() => create());
</script>

<Modal bind:open={() => open, (value) => { open = value; if (!value) onclose(); }} title="Link another device"
  description="Scan the QR code on the other device, then enter the link code. Anyone with both can import your private key, so close this dialog once linking finishes.">
  {#await link}
    <p class="form-status" role="status">Preparing link…</p>
  {:then { payload, code }}
    <div class="link-frame">
      <!-- Low error correction keeps the code sparse enough to scan with many saved servers. -->
      <SvgQR data={payload} correction="L" margin={2} role="img" aria-label="Device link QR code" />
    </div>
    <p class="link-code" aria-label="Link code">{code}</p>
  {:catch cause}
    <p class="form-error" role="alert">{messageFrom(cause)}</p>
  {/await}
  <div class="dialog-actions">
    <Button variant="default" type="button" onclick={onclose}>Done</Button>
  </div>
</Modal>

<style>
  /* The highest-contrast theme pair; modules inherit `color` through currentcolor. */
  .link-frame {
    width: min(100%, 260px);
    margin: 0.5rem auto;
    padding: 0.75rem;
    border-radius: var(--radius);
    background: var(--foreground);
    color: var(--background);
  }

  .link-frame :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }

  .link-code {
    justify-self: center;
    width: fit-content;
    margin: 0.5rem auto 0;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--muted);
    color: var(--foreground);
    text-align: center;
    font-family: var(--font-mono, monospace);
    font-size: 1.25rem;
    letter-spacing: 0.12em;
    user-select: all;
  }
</style>
