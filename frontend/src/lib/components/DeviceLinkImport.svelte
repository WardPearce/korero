<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { messageFrom } from "#lib/connection/client";
  import { importDeviceLink, type LinkedIdentity } from "#lib/identity/device-link";
  import { Smartphone } from "@lucide/svelte";
  import Modal from "./Modal.svelte";
  import DeviceLinkScanner from "./DeviceLinkScanner.svelte";

  let { open, onback, oncomplete }: {
    open: boolean;
    onback: () => void;
    oncomplete: (result: LinkedIdentity) => void;
  } = $props();
  let payload = $state("");
  let code = $state("");
  let busy = $state(false);
  let error = $state("");

  function scanned(value: string) {
    payload = value;
    error = "";
  }

  function rescan() {
    payload = "";
    code = "";
    error = "";
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      const linked = await importDeviceLink(payload, code);
      payload = "";
      code = "";
      oncomplete(linked);
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }
</script>

<Modal {open} title="Link from another device"
  description="Scan the QR code shown on a device that already has this identity, then enter the link code it displays."
  dismissible={false}>
  {#snippet icon()}<Smartphone size={22} />{/snippet}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  {#if payload}
    <form class="dialog-form" onsubmit={submit}>
      <label>Link code<Input required autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength={19}
        placeholder="XXXX-XXXX-XXXX-XXXX" bind:value={code} disabled={busy} /></label>
      <div class="dialog-actions">
        <Button variant="outline" type="button" disabled={busy} onclick={rescan}>Scan again</Button>
        <Button variant="default" type="submit" disabled={busy}>{busy ? "Linking…" : "Link device"}</Button>
      </div>
    </form>
  {:else}
    <DeviceLinkScanner onscan={scanned} onerror={(message) => { error = message; }} />
    <div class="dialog-actions">
      <Button variant="outline" type="button" onclick={onback}>Back</Button>
    </div>
  {/if}
</Modal>
