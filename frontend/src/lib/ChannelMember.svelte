<script lang="ts">
  import { Button, SliderField } from "gridworkdesign";
  import { HeadphoneOff, MicOff, Volume2 } from "@lucide/svelte";
  import { tick } from "svelte";
  import Avatar from "./Avatar.svelte";
  import ContextActions from "./ContextActions.svelte";
  import Modal from "./Modal.svelte";
  import { nativeApp, type Channel, type Member, type MemberRequest } from "./client";
  import { getWorkspace } from "./workspace";

  let { channel, member }: { channel: Channel; member: Member } = $props();
  const workspace = getWorkspace();
  const voiceAvailable = nativeApp();
  const snapshot = $derived(workspace.view.snapshot);
  const ownAccount = $derived(member.accountId === snapshot?.account.id);
  const canModerate = $derived(!ownAccount && Boolean(member.role && snapshot?.lowerRoles?.includes(member.role)));
  const roles = $derived(canModerate ? snapshot?.assignableRoles ?? [] : []);
  const speaking = $derived(!member.afk && (member.speaking ?? workspace.view.speaking.includes(member.connectionId)));
  const canAdjustVolume = $derived(voiceAvailable && !ownAccount && snapshot?.lowerRoles !== undefined);
  let dialog = $state<"volume" | "kick" | "ban">("volume");
  let dialogOpen = $state(false);
  let volume = $state(100);

  const actions = $derived.by(() => {
    const actions: { label: string; onSelect: () => void; disabled?: boolean }[] = [];
    if (canAdjustVolume) actions.push({ label: "User volume…", onSelect: () => showDialog("volume") });
    if (canModerate && channel.canMute) {
      actions.push(
        { label: member.adminMuted ? "Server unmute" : "Server mute",
          onSelect: () => act({ kind: "moderation.mute", payload: { connectionId: member.connectionId, muted: !member.adminMuted } }) },
        { label: member.adminDeafened ? "Server undeafen" : "Server deafen",
          onSelect: () => act({ kind: "moderation.deafen", payload: { connectionId: member.connectionId, deafened: !member.adminDeafened } }) },
      );
    }
    if (canModerate && snapshot?.serverPermissions.includes("kick")) {
      actions.push({ label: "Kick from server…", onSelect: () => showDialog("kick") });
    }
    if (canModerate && snapshot?.serverPermissions.includes("ban")) {
      actions.push({ label: "Ban from server…", onSelect: () => showDialog("ban") });
    }
    for (const role of roles) {
      actions.push({
        label: member.role === role ? `Role: ${role} (current)` : `Set role: ${role}`,
        disabled: member.role === role,
        onSelect: () => act({ kind: "role.set", payload: { accountId: member.accountId, role } }),
      });
    }
    return actions;
  });
  const enabled = $derived(workspace.view.phase === "online" && !workspace.pending && Boolean(actions.length));

  function act(request: MemberRequest) {
    void workspace.memberAction(request);
  }

  async function showDialog(kind: typeof dialog) {
    workspace.actionError = "";
    dialog = kind;
    if (kind === "volume") volume = workspace.memberVolume(member.accountId);
    await tick();
    dialogOpen = true;
  }

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    const ok = dialog === "volume" ? await workspace.setMemberVolume(member.accountId, volume)
      : await workspace.memberAction({
        kind: dialog === "kick" ? "moderation.kick" : "moderation.ban",
        payload: { accountId: member.accountId },
      });
    if (ok) dialogOpen = false;
  }
</script>

<li>
  <ContextActions {actions} disabled={!enabled} openOnClick>
    {#snippet trigger(props)}
      <button {...props} type="button" class="tree-member member-target" tabindex={enabled ? 0 : -1}
        aria-haspopup={enabled ? "menu" : undefined}>
        <Avatar name={member.displayName} small {speaking} afk={member.afk} />
        <span class="member-details">
          <span class="truncate" title={member.displayName}>{member.displayName}</span>
          {#if member.afk}
            <span class="afk-label">AFK</span>
            {#if member.afkMessage}<span class="afk-message">{member.afkMessage}</span>{/if}
          {/if}
        </span>
        {#if member.adminDeafened || member.deafened}
          <HeadphoneOff size={13} class="member-state" aria-label={member.adminDeafened ? "Server deafened" : "Deafened"} />
        {/if}
        {#if member.adminMuted || member.muted}
          <MicOff size={13} class="member-state" aria-label={member.adminMuted ? "Server muted" : "Muted"} />
        {/if}
        {#if speaking}<Volume2 size={13} class="speaking-icon" aria-label="Speaking" />{/if}
      </button>
    {/snippet}
  </ContextActions>
</li>

{#if dialogOpen}
  <Modal bind:open={dialogOpen}
    title={dialog === "volume" ? `${member.displayName}’s volume` : `${dialog === "kick" ? "Kick" : "Ban"} ${member.displayName}?`}
    description={dialog === "volume" ? "Changes how loudly you hear this user on this device."
      : dialog === "kick" ? "Their devices will be disconnected from the server."
      : "Their devices will be disconnected and their account will be blocked from rejoining."}>
    <form class="dialog-form" onsubmit={confirm}>
      {#if dialog === "volume"}
        <SliderField label="Volume (%)" bind:value={volume} disabled={Boolean(workspace.pending)} />
      {/if}
      {#if workspace.actionError}<p class="form-error" role="alert">{workspace.actionError}</p>{/if}
      <div class="dialog-actions">
        <Button type="button" onclick={() => { dialogOpen = false; }}>Cancel</Button>
        <Button type="submit" variant="alternate" disabled={Boolean(workspace.pending)}>
          {dialog === "volume" ? "Apply" : dialog === "kick" ? "Kick" : "Ban"}
        </Button>
      </div>
    </form>
  </Modal>
{/if}
