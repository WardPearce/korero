<script lang="ts">
  import { BitsConfig } from "bits-ui";
  import { untrack } from "svelte";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import VoiceBitrateField from "#lib/components/fields/VoiceBitrateField.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import type { Channel } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";

  let { editing, onsaved }: {
    editing: Channel | null;
    onsaved: () => void;
  } = $props();

  const workspace = getWorkspace();
  const view = $derived(workspace.view);
  const pending = $derived(workspace.pending);
  const actionError = $derived(workspace.actionError);
  const channelFormOrigin = workspace.serverOrigin;

  let channelForm = $state<HTMLFormElement>();
  let newChannelName = $state(untrack(() => editing?.name ?? ""));
  let channelDescription = $state(untrack(() => editing?.description ?? ""));
  let channelCapacity = $state<number | undefined>(untrack(() => editing?.capacity ?? undefined));
  let parentChannelId = $state(untrack(() => editing?.parentId ?? ""));
  let newChannelPassword = $state("");
  let removeChannelPassword = $state(false);
  let backgroundImageUrl = $state(untrack(() => editing?.backgroundImageUrl ?? ""));
  let channelIcon = $state(untrack(() => editing?.icon ?? ""));
  let channelAudioBitrate = $state<number | null>(untrack(() => editing?.audioBitrate ?? null));

  let snapshot = $derived(view.snapshot);
  let online = $derived(view.phase === "online");
  let canSetAudioBitrate = $derived(workspace.channelAudioQuality && (editing
    ? editing.canSetAudioBitrate
    : snapshot?.serverPermissions.includes("manageSettings")));
  let canSetChannelAccess = $derived(editing?.canSetPassword !== false);
  let possibleParents = $derived((snapshot?.channels ?? []).filter((parent, _, all) => {
    for (let candidate: Channel | undefined = parent; candidate; candidate = all.find(({ id }) => id === candidate?.parentId)) {
      if (candidate.temporary || candidate.id === editing?.id) return false;
    }
    return true;
  }));
  const topLevel = "Top level";
  const topLevelValue = "top-level";
  const parentOptions = $derived.by(() => {
    const options = [{ id: "", label: topLevel, value: topLevelValue }];
    const labels = new Set([topLevel]);
    for (const parent of possibleParents) {
      let label = parent.name;
      for (let number = 2; labels.has(label); number++) label = `${parent.name} (${number})`;
      labels.add(label);
      options.push({ id: parent.id, label, value: `channel:${parent.id}` });
    }
    return options;
  });
  const selectedParent = $derived(parentOptions.find(({ id }) => id === parentChannelId)?.value ?? "");

  function selectParent(value: string) {
    const parent = parentOptions.find((option) => option.value === value);
    if (parent) parentChannelId = parent.id;
  }

  async function saveChannel(event: SubmitEvent) {
    event.preventDefault();
    if (!online || channelFormOrigin !== workspace.serverOrigin) {
      workspace.actionError = "Reconnect to this server to save the channel.";
      return;
    }
    const payload: Record<string, unknown> = { name: newChannelName.trim(), description: channelDescription };
    if (editing) payload.channelId = editing.id;
    if (canSetAudioBitrate && channelAudioBitrate !== (editing?.audioBitrate ?? null)) payload.audioBitrate = channelAudioBitrate;
    if (workspace.channelBackgrounds) payload.backgroundImageUrl = backgroundImageUrl.trim() || null;
    if (workspace.channelIcons) payload.icon = channelIcon.trim() || null;
    if (canSetChannelAccess) {
      if (parentChannelId !== (editing?.parentId ?? "")) payload.parentId = parentChannelId || null;
      if (channelCapacity !== (editing?.capacity ?? undefined)) payload.capacity = channelCapacity ?? null;
      if (removeChannelPassword) payload.password = null;
      else if (newChannelPassword) payload.password = newChannelPassword;
    }
    if (await workspace.run("channel-save", "save_channel", { payload })) {
      newChannelPassword = "";
      onsaved();
    }
  }
</script>

<form class="dialog-form" bind:this={channelForm} onsubmit={saveChannel}>
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <label>Channel name<Input required maxlength={80} bind:value={newChannelName} /></label>
  <label>Description<Textarea rows={2} maxlength={1000} bind:value={channelDescription} /></label>
  {#if canSetChannelAccess}
    {#if channelForm}
      <BitsConfig defaultPortalTo={channelForm}>
        <SelectField label="Parent channel" options={parentOptions} placeholder="Current parent unavailable"
          bind:value={() => selectedParent, selectParent} />
      </BitsConfig>
    {/if}
    <label>Capacity<Input type="number" min="1" max="1024" placeholder="Server default" bind:value={channelCapacity} /></label>
    <label>{editing?.passwordRequired ? "New password" : "Channel password"}
      <Input type="password" autocomplete="new-password" maxlength={128} disabled={removeChannelPassword} bind:value={newChannelPassword}
        placeholder={editing?.passwordRequired ? "Leave blank to keep current password" : "Optional"} />
    </label>
    {#if editing?.passwordRequired}
      <Checkbox label="Remove channel password" bind:checked={removeChannelPassword} />
    {/if}
  {/if}
  {#if canSetAudioBitrate && channelForm}
    <BitsConfig defaultPortalTo={channelForm}>
      <VoiceBitrateField label="Voice bitrate" defaultLabel="Server default"
        defaultBitrate={snapshot?.targetAudioBitrate} savedBitrate={editing?.audioBitrate} bind:value={channelAudioBitrate} />
    </BitsConfig>
  {/if}
  {#if workspace.channelIcons}
    <label>Channel emoji <Input maxlength={16} placeholder="Optional, for example 🎮" autocomplete="off" spellcheck="false" bind:value={channelIcon} /></label>
    {#if editing}<p class="field-hint">Clear the emoji to remove the channel icon.</p>{/if}
  {/if}
  {#if workspace.channelBackgrounds}
    <label>Background image URL <Input type="url" pattern="https://.+" maxlength={512} placeholder="https://example.com/channel.jpg"
      autocomplete="off" spellcheck="false" title="Use an HTTPS image URL" bind:value={backgroundImageUrl} /></label>
    {#if editing}<p class="field-hint">Clear the URL to remove the background.</p>{/if}
  {/if}
  <Button variant="default" type="submit" disabled={Boolean(pending)}>{editing ? "Save changes" : "Create channel"}</Button>
</form>
