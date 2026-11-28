<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Activity, Ban, BellRing, HeadphoneOff, LogOut, MessageCircle, MicOff, MonitorUp, Shield, Volume2 } from "@lucide/svelte";
  import { tick } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import ContextActions from "#lib/components/ContextActions.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import * as ContextMenu from "#lib/components/ui/context-menu/index.js";
  import { Root as Slider } from "#lib/components/ui/slider/index.js";
  import { apiFor, messageFrom, requestError, type Channel, type Member, type MemberRequest } from "#lib/connection/client";
  import { banDurationOptions, banPayload, type BanDuration } from "#lib/ban-duration";
  import { maxMemberVolume } from "#lib/preferences";
  import { getWorkspace } from "#lib/workspace";

  let { channel, member, selected, onToggleSelection, onDragStart, onDragEnd }: {
    channel: Channel;
    member: Member;
    selected: boolean;
    onToggleSelection?: () => void;
    onDragStart?: (event: DragEvent) => void;
    onDragEnd: () => void;
  } = $props();
  const workspace = getWorkspace();
  import { voiceApp } from "#lib/connection/platform";

  const voiceAvailable = voiceApp();
  const snapshot = $derived(workspace.view.snapshot);
  const ownAccount = $derived(member.accountId === snapshot?.account.id);
  const canOpenDirectMessage = $derived(!ownAccount && Boolean(snapshot?.directMessages && workspace.serverId));
  const canPoke = $derived(!ownAccount && Boolean(snapshot?.pokeMaxLength && snapshot.directMessages?.canSend));
  const canModerate = $derived(!ownAccount && Boolean(member.role && snapshot?.lowerRoles?.includes(member.role)));
  const displayedRole = $derived(member.role === "Guest" || member.role === "Member" ? undefined : member.role);
  const roles = $derived(canModerate ? snapshot?.assignableRoles ?? [] : []);
  const heldRoles = $derived(member.roles ?? (member.role ? [member.role] : []));
  const baseRoles = ["Guest", "Member"];
  /** Every account keeps Guest or Member, so the last one cannot be removed. */
  function isLastBaseRole(role: string) {
    return baseRoles.includes(role) && !heldRoles.some((held) => held !== role && baseRoles.includes(held));
  }
  const canMute = $derived(canModerate && channel.canMute);
  const canKick = $derived(canModerate && snapshot?.serverPermissions.includes("kick"));
  const canBan = $derived(canModerate && snapshot?.serverPermissions.includes("ban"));
  const speaking = $derived(!member.afk && (member.speaking ?? workspace.view.speaking.includes(member.connectionId)));
  const sharingScreen = $derived(snapshot?.channelId === channel.id &&
    snapshot.screens?.some(({ connectionId }) => connectionId === member.connectionId));
  const canAdjustVolume = $derived(voiceAvailable && !ownAccount && snapshot?.lowerRoles !== undefined);
  let dialog = $state<"kick" | "ban">("kick");
  let dialogOpen = $state(false);
  let banDuration = $state<BanDuration>("never");
  let nameDialogOpen = $state(false);
  let nameDraft = $state("");
  let nameError = $state("");
  let savingName = $state(false);
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

  async function saveName(event: SubmitEvent) {
    event.preventDefault();
    if (savingName || !snapshot) return;
    savingName = true;
    nameError = "";
    try {
      const response = await apiFor(workspace.serverOrigin).account.patch({ displayName: nameDraft.trim() });
      if (response.error) throw requestError(response.error);
      nameDialogOpen = false;
    } catch (error) {
      nameError = messageFrom(error);
    } finally {
      savingName = false;
    }
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
    banDuration = "never";
    await tick();
    dialogOpen = true;
  }

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    const ok = await workspace.memberAction(dialog === "kick"
      ? { kind: "moderation.kick", payload: { accountId: member.accountId } }
      : { kind: "moderation.ban", payload: banPayload(member.accountId, banDuration) });
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
      {#if canPoke}
        <ContextMenu.Item onSelect={() => workspace.showPoke(member)}><BellRing /> Poke…</ContextMenu.Item>
      {/if}
      {#if ownAccount}
        <ContextMenu.Item onSelect={() => { nameDraft = member.displayName; nameError = ""; nameDialogOpen = true; }}>Change display name…</ContextMenu.Item>
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
            {#each roles as role (role)}
              {@const held = heldRoles.includes(role)}
              <ContextMenu.CheckboxItem checked={held} disabled={held && isLastBaseRole(role)}
                onCheckedChange={(checked) => act({ kind: checked ? "role.add" : "role.remove", payload: { accountId: member.accountId, role } })}>
                {role}
              </ContextMenu.CheckboxItem>
            {/each}
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
        aria-haspopup={enabled ? "menu" : undefined} aria-pressed={onToggleSelection ? selected : undefined}
        draggable={enabled && Boolean(onDragStart)}
        onclick={(event) => {
          if (enabled && onToggleSelection && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onToggleSelection();
          } else props.onclick?.(event);
        }}
        ondblclick={(event) => {
          if (!onToggleSelection || !(event.ctrlKey || event.metaKey)) props.ondblclick?.();
        }}
        ondragstart={(event) => {
          if (enabled && onDragStart) onDragStart(event);
          else event.preventDefault();
        }}
        ondragend={onDragEnd}>
        <Avatar name={member.displayName} accountId={member.accountId} {speaking} afk={member.afk} />
        <span class="member-details">
          <span class="member-line">
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
          </span>
          {#if member.afk}
            <span class="member-afk">
              <span class="afk-label">AFK</span>
              {#if member.afkMessage}<span class="afk-message" title={member.afkMessage}>{member.afkMessage}</span>{/if}
            </span>
          {/if}
        </span>
        {#if member.adminDeafened || member.deafened || member.adminMuted || member.muted}
          <span class="member-states">
            {#if member.adminDeafened || member.deafened}
              <HeadphoneOff size={16} strokeWidth={2.25} class={member.adminDeafened ? "member-state member-state-server" : "member-state"}
                role="img" aria-label={member.adminDeafened ? "Server deafened" : "Deafened"}
                title={member.adminDeafened ? "Server deafened" : "Deafened"} />
            {/if}
            {#if member.adminMuted || member.muted}
              <MicOff size={16} strokeWidth={2.25} class={member.adminMuted ? "member-state member-state-server" : "member-state"}
                role="img" aria-label={member.adminMuted ? "Server muted" : "Muted"}
                title={member.adminMuted ? "Server muted" : "Muted"} />
            {/if}
          </span>
        {/if}
      </button>
    {/snippet}
  </ContextActions>
</li>

{#if nameDialogOpen}
  <Modal bind:open={nameDialogOpen} title="Change display name" description="Choose the name other members see on this server.">
    <form class="dialog-form" onsubmit={saveName}>
      <label>Display name<Input required maxlength={80} bind:value={nameDraft} /></label>
      {#if nameError}<p class="form-error" role="alert">{nameError}</p>{/if}
      <div class="dialog-actions">
        <Button variant="outline" type="button" onclick={() => { nameDialogOpen = false; }}>Cancel</Button>
        <Button type="submit" disabled={savingName}>{savingName ? "Saving…" : "Save name"}</Button>
      </div>
    </form>
  </Modal>
{/if}

{#if dialogOpen}
  <Modal bind:open={dialogOpen}
    title={`${dialog === "kick" ? "Kick" : "Ban"} ${member.displayName}?`}
    description={dialog === "kick" ? "Their devices will be disconnected from the server."
      : "Their devices will be disconnected and their account will be blocked from rejoining."}>
    <form class="dialog-form" onsubmit={confirm}>
      {#if dialog === "ban"}
        <SelectField label="Expires after" options={banDurationOptions} bind:value={banDuration} />
      {/if}
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
