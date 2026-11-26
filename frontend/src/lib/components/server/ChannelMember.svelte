<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Activity, Ban, HeadphoneOff, LogOut, MessageCircle, MicOff, MonitorUp, Shield, Volume2 } from "@lucide/svelte";
  import { tick } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import ContextActions from "#lib/components/ContextActions.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import * as ContextMenu from "#lib/components/ui/context-menu/index.js";
  import { Root as Slider } from "#lib/components/ui/slider/index.js";
  import { nativeApp, type Channel, type Member, type MemberRequest } from "#lib/connection/client";
  import { maxMemberVolume } from "#lib/preferences";
  import { getWorkspace } from "#lib/workspace";

  let { channel, member }: { channel: Channel; member: Member } = $props();
  const workspace = getWorkspace();
  const voiceAvailable = nativeApp();
  const snapshot = $derived(workspace.view.snapshot);
  const ownAccount = $derived(member.accountId === snapshot?.account.id);
  const canOpenDirectMessage = $derived(!ownAccount && Boolean(snapshot?.directMessages && workspace.serverId));
  const canModerate = $derived(!ownAccount && Boolean(member.role && snapshot?.lowerRoles?.includes(member.role)));
  const displayedRole = $derived(member.role === "Guest" || member.role === "Member" ? undefined : member.role);
  const roles = $derived(canModerate ? snapshot?.assignableRoles ?? [] : []);
  const canMute = $derived(canModerate && channel.canMute);
  const canKick = $derived(canModerate && snapshot?.serverPermissions.includes("kick"));
  const canBan = $derived(canModerate && snapshot?.serverPermissions.includes("ban"));
  const speaking = $derived(!member.afk && (member.speaking ?? workspace.view.speaking.includes(member.connectionId)));
  const sharingScreen = $derived(snapshot?.channelId === channel.id &&
    snapshot.screens?.some(({ connectionId }) => connectionId === member.connectionId));
  const canAdjustVolume = $derived(voiceAvailable && !ownAccount && snapshot?.lowerRoles !== undefined);
  let dialog = $state<"kick" | "ban">("kick");
  let dialogOpen = $state(false);
  const volumeLabelId = $props.id();
  let volumePreview = $state<number>();
  let volume = $derived(volumePreview ?? workspace.memberVolume(member.accountId));
  let volumeRevision = 0;
  let volumeSlider = $state<HTMLElement | null>(null);

  const enabled = $derived(workspace.view.phase === "online" && !workspace.pending);

  function openDirectMessage() {
    workspace.showDirectMessages(member.accountId);
  }

  function act(request: MemberRequest) {
    void workspace.memberAction(request);
  }

  function previewVolume(level: number | undefined) {
    volumePreview = level;
    volumeRevision++;
  }

  async function commitVolume(level: number) {
    const revision = volumeRevision;
    await workspace.setMemberVolume(member.accountId, level);
    if (revision === volumeRevision) volumePreview = undefined;
  }

  async function showDialog(kind: typeof dialog) {
    workspace.actionError = "";
    dialog = kind;
    await tick();
    dialogOpen = true;
  }

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    const ok = await workspace.memberAction({
      kind: dialog === "kick" ? "moderation.kick" : "moderation.ban",
      payload: { accountId: member.accountId },
    });
    if (ok) dialogOpen = false;
  }
</script>

<li>
  <ContextActions disabled={!enabled} openOnClick onDoubleClick={canOpenDirectMessage ? openDirectMessage : undefined}
    onOpenChange={(open) => { if (open) previewVolume(undefined); }}>
    {#snippet content()}
      {#if displayedRole}
        <ContextMenu.Label class="wrap-anywhere">Role: {displayedRole}</ContextMenu.Label>
        <ContextMenu.Separator />
      {/if}
      {#if canOpenDirectMessage}
        <ContextMenu.Item onSelect={openDirectMessage}><MessageCircle /> Direct message</ContextMenu.Item>
      {/if}
      {#if canAdjustVolume}
        <ContextMenu.Item closeOnSelect={false} aria-labelledby={volumeLabelId} class="min-w-44 flex-col items-stretch gap-0"
          onSelect={() => volumeSlider?.querySelector<HTMLElement>('[role="slider"]')?.focus()}>
          <div class="flex items-center gap-1.5">
            <Volume2 aria-hidden="true" />
            <span id={volumeLabelId}>Volume</span>
            <span class="ml-auto tabular-nums">{volume}%</span>
          </div>
          <Slider type="single" min={0} max={maxMemberVolume} class="min-h-6" thumbLabelledBy={volumeLabelId}
            bind:ref={volumeSlider} value={volume} onValueChange={previewVolume} onValueCommit={commitVolume} />
        </ContextMenu.Item>
      {/if}
      <ContextMenu.Item onSelect={() => workspace.showConnectionInfo(member.connectionId)}><Activity /> Connection info</ContextMenu.Item>
      {#if roles.length}
        <ContextMenu.Separator />
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger><Shield /> Roles</ContextMenu.SubTrigger>
          <ContextMenu.SubContent class="max-h-(--bits-context-menu-content-available-height) overflow-y-auto">
            <ContextMenu.RadioGroup value={member.role ?? ""} onValueChange={(role) => act({ kind: "role.set", payload: { accountId: member.accountId, role } })}>
              {#each roles as role (role)}
                <ContextMenu.RadioItem value={role} disabled={role === member.role} closeOnSelect>{role}</ContextMenu.RadioItem>
              {/each}
            </ContextMenu.RadioGroup>
          </ContextMenu.SubContent>
        </ContextMenu.Sub>
      {/if}
      {#if canMute || canKick || canBan}
        <ContextMenu.Separator />
        <ContextMenu.Group>
          <ContextMenu.GroupHeading>Moderation</ContextMenu.GroupHeading>
          {#if canMute}
            <ContextMenu.Item onSelect={() => act({ kind: "moderation.mute", payload: { connectionId: member.connectionId, muted: !member.adminMuted } })}>
              <MicOff /> {member.adminMuted ? "Server unmute" : "Server mute"}
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => act({ kind: "moderation.deafen", payload: { connectionId: member.connectionId, deafened: !member.adminDeafened } })}>
              <HeadphoneOff /> {member.adminDeafened ? "Server undeafen" : "Server deafen"}
            </ContextMenu.Item>
          {/if}
          {#if canKick}
            <ContextMenu.Item onSelect={() => showDialog("kick")}><LogOut /> Kick from server…</ContextMenu.Item>
          {/if}
          {#if canBan}
            <ContextMenu.Item variant="destructive" onSelect={() => showDialog("ban")}><Ban /> Ban from server…</ContextMenu.Item>
          {/if}
        </ContextMenu.Group>
      {/if}
    {/snippet}
    {#snippet trigger(props)}
      <button {...props} type="button" class="tree-member member-target" tabindex={enabled ? 0 : -1}
        aria-haspopup={enabled ? "menu" : undefined}>
        <Avatar name={member.displayName} small {speaking} afk={member.afk} />
        <span class="member-details">
          <span class="inline-flex min-w-0 items-center gap-1.5">
            <span class="truncate" title={member.displayName}>{member.displayName}</span>
            {#if sharingScreen}
              <span class="shrink-0 text-(--destructive)" title="Sharing their screen">
                <MonitorUp size={14} aria-hidden="true" />
                <span class="sr-only">Sharing their screen</span>
              </span>
            {/if}
          </span>
          {#if displayedRole}<span class="member-badge member-role" title={displayedRole}>{displayedRole}</span>{/if}
          {#if member.badge}<span class="member-badge" title={member.badge}>{member.badge}</span>{/if}
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
    title={`${dialog === "kick" ? "Kick" : "Ban"} ${member.displayName}?`}
    description={dialog === "kick" ? "Their devices will be disconnected from the server."
      : "Their devices will be disconnected and their account will be blocked from rejoining."}>
    <form class="dialog-form" onsubmit={confirm}>
      {#if workspace.actionError}<p class="form-error" role="alert">{workspace.actionError}</p>{/if}
      <div class="dialog-actions">
        <Button variant="outline" type="button" onclick={() => { dialogOpen = false; }}>Cancel</Button>
        <Button type="submit" variant="default" disabled={Boolean(workspace.pending)}>
          {dialog === "kick" ? "Kick" : "Ban"}
        </Button>
      </div>
    </form>
  </Modal>
{/if}
