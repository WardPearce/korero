<script lang="ts">
  import { ContextMenu } from "bits-ui";
  import { Check, ChevronRight, HeadphoneOff, MicOff, Volume2 } from "lucide-svelte";
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
    const actions: { label: string; select: () => void; danger?: boolean }[] = [];
    if (canAdjustVolume) actions.push({ label: "User volume…", select: () => showDialog("volume") });
    if (canModerate && channel.canMute) {
      actions.push(
        { label: member.adminMuted ? "Server unmute" : "Server mute",
          select: () => act({ kind: "moderation.mute", payload: { connectionId: member.connectionId, muted: !member.adminMuted } }) },
        { label: member.adminDeafened ? "Server undeafen" : "Server deafen",
          select: () => act({ kind: "moderation.deafen", payload: { connectionId: member.connectionId, deafened: !member.adminDeafened } }) },
      );
    }
    if (canModerate && snapshot?.serverPermissions.includes("kick")) {
      actions.push({ label: "Kick from server…", danger: true, select: () => showDialog("kick") });
    }
    if (canModerate && snapshot?.serverPermissions.includes("ban")) {
      actions.push({ label: "Ban from server…", danger: true, select: () => showDialog("ban") });
    }
    return actions;
  });
  const enabled = $derived(workspace.view.phase === "online" && !workspace.pending && Boolean(actions.length || roles.length));

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

{#snippet roleMenu()}
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger class="context-menu-item role-option">Roles <ChevronRight size={14} /></ContextMenu.SubTrigger>
    <ContextMenu.Portal>
      <ContextMenu.SubContent class="context-menu" sideOffset={4}>
        {#each roles as role (role)}
          <ContextMenu.Item class="context-menu-item role-option" disabled={member.role === role}
            onSelect={() => act({ kind: "role.set", payload: { accountId: member.accountId, role } })}>
            {role}{#if member.role === role}<Check size={14} aria-label="Current role" />{/if}
          </ContextMenu.Item>
        {/each}
      </ContextMenu.SubContent>
    </ContextMenu.Portal>
  </ContextMenu.Sub>
{/snippet}

<li>
  <ContextActions {actions} menu={roles.length ? roleMenu : undefined} disabled={!enabled} openOnClick>
    {#snippet trigger({ props })}
      <button {...props} type="button" class="tree-member member-target" tabindex={enabled ? 0 : -1}
        aria-haspopup={enabled ? "menu" : undefined}>
        <Avatar name={member.displayName} class="avatar-small" {speaking} afk={member.afk} />
        <span class="member-details">
          <span class="truncate" title={member.displayName}>{member.displayName}</span>
          {#if member.afk}
            <span class="afk-label">AFK</span>
            {#if member.afkMessage}<span class="afk-message">{member.afkMessage}</span>{/if}
          {/if}
        </span>
        {#if member.connectionId === snapshot?.connectionId}<small>you</small>{/if}
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
        <label>Volume <output>{volume}%</output>
          <input type="range" min="0" max="100" step="1" bind:value={volume} disabled={Boolean(workspace.pending)} />
        </label>
      {/if}
      {#if workspace.actionError}<p class="form-error" role="alert">{workspace.actionError}</p>{/if}
      <div class="dialog-actions">
        <button type="button" class="secondary-button" onclick={() => { dialogOpen = false; }}>Cancel</button>
        <button type="submit" class="primary-button" disabled={Boolean(workspace.pending)}>
          {dialog === "volume" ? "Apply" : dialog === "kick" ? "Kick" : "Ban"}
        </button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .member-target { width: 100%; text-align: left; }
  .member-target:not(:disabled):is(:hover, :focus-visible, [data-state="open"]) { background: var(--selected); }
  :global(.context-menu-item.role-option) { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  :global(.context-menu-item.role-option[data-disabled]) { color: var(--muted); cursor: default; }
</style>
