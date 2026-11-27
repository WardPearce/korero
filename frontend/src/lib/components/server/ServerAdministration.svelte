<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import VoiceBitrateField from "#lib/components/fields/VoiceBitrateField.svelte";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { onMount } from "svelte";
  import { Settings2, X } from "@lucide/svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import ServerAuditLog from "./ServerAuditLog.svelte";
  import { apiFor, messageFrom, requestError } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";

  let { origin, title, permissions, bannerSupported, bannerImageUrl, extended, onclose }: {
    origin: string;
    title: string;
    permissions: string[];
    onclose: () => void;
    bannerSupported: boolean;
    bannerImageUrl: string | null;
    extended: boolean;
  } = $props();

  const workspace = getWorkspace();

  const tabs = [
    { id: "overview", label: "Overview", permission: "manageSettings" },
    { id: "users", label: "Users", permission: "manageRoles" },
    { id: "roles", label: "Roles", permission: "manageRoles" },
    { id: "audit", label: "Audit log", permission: "viewAdmin" },
    { id: "invitation", label: "Invitations", permission: "manageInvitations" },
  ] as const;
  type Tab = typeof tabs[number]["id"];
  type Roles = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["accounts"]["get"]>>["data"], { accounts: unknown }>;
  type RoleDefinition = Roles["customRoles"][number];
  type Permission = RoleDefinition["permissions"][number];
  const permissionLabels: Record<Permission, string> = {
    join: "See and join channels", speak: "Speak in voice", text: "Read and send channel messages", createChannels: "Create channels",
    editChannels: "Edit channels", removeChannels: "Delete channels", deleteChannels: "Delete other members’ channel messages",
    move: "Move members", mute: "Mute members",
    kick: "Kick members", ban: "Ban members", manageRoles: "Assign roles", manageInvitations: "Manage invitations",
    manageSettings: "Manage server settings", viewAdmin: "View diagnostics and audit log",
    attachFiles: "Upload attachments", sendDirectMessages: "Send direct messages", shareScreen: "Share screen",
    useCamera: "Use camera", whisper: "Whisper to other channels",
  };
  const permissionGroups = [
    { label: "Channel access and voice", permissions: ["join", "speak", "shareScreen", "useCamera", "whisper"] },
    { label: "Messaging", permissions: ["text", "attachFiles", "sendDirectMessages", "deleteChannels"] },
    { label: "Channel management", permissions: ["createChannels", "editChannels", "removeChannels"] },
    { label: "Moderation", permissions: ["move", "mute", "kick", "ban"] },
    { label: "Server administration", permissions: ["manageRoles", "manageInvitations", "manageSettings", "viewAdmin"] },
  ] satisfies { label: string; permissions: Permission[] }[];
  const roleTemplates: RoleDefinition[] = [
    { name: "Listener", permissions: ["join"] },
    { name: "Text-only", permissions: ["join", "text"] },
    { name: "Presenter", permissions: ["join", "speak", "shareScreen", "useCamera"] },
    { name: "Channel Manager", permissions: ["join", "speak", "text", "createChannels", "editChannels", "removeChannels", "move"] },
    { name: "Invitation Manager", permissions: ["join", "manageInvitations"] },
  ];
  type ServerPreferences = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["preferences"]["get"]>>["data"], { motd: string }>;
  type InvitationList = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["invitations"]["get"]>>["data"], { invitations: unknown }>;
  type Invitation = InvitationList["invitations"][number];
  let tab = $state<Tab>("roles");
  let availableTabs = $derived(tabs.filter(({ id, permission }) => permissions.includes(permission) &&
    (id === "overview" ? extended || bannerSupported : id !== "audit" || extended)));
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let members = $state.raw<Roles | null>(null);
  let pages = $state<(string | undefined)[]>([undefined]);
  let invitations = $state.raw<Invitation[] | null>(null);
  let createdInvitation = $state.raw<{ id: string; url: string } | null>(null);
  let editedInvitation = $state.raw<Invitation | null>(null);
  let deletingInvitation = $state("");
  let invitationLimit = $state<number | undefined>(1);
  const expiryOptions = ["1 hour", "2 hours", "3 hours", "6 hours", "12 hours", "24 hours", "1 week", "3 months", "Never"] as const;
  const expirySelectOptions = expiryOptions.map((option) => ({ value: option, label: option }));
  type ExpiryOption = typeof expiryOptions[number];
  let invitationExpiry = $state<ExpiryOption>("24 hours");
  let originalExpiryChoice = $state<ExpiryOption>("24 hours");
  let expiryChanged = $derived(invitationExpiry !== originalExpiryChoice);
  let invitationChanged = $derived(editedInvitation && (
    invitationLimit !== (editedInvitation.usesLeft ?? undefined) || expiryChanged
  ));
  let bannerUrl = $state("");
  let roleEditing = $state(false);
  let editedRole = $state("");
  let editingBadge = $state("");
  let badgeDraft = $state("");
  let banningAccount = $state("");
  let deletingRole = $state("");
  let roleName = $state("");
  let selectedTemplate = $state("");
  let rolePermissions = $state<Permission[]>([]);
  const roleDefaults = $derived(members?.builtInRoles?.find(({ name }) => name === editedRole)?.defaultPermissions);
  const editingDefaultRole = $derived(Boolean(editedRole && editedRole === members?.defaultRole));
  const templateOptions = $derived(roleTemplates.filter(({ permissions }) =>
    permissions.every((permission) => members?.assignablePermissions.includes(permission)))
    .map(({ name }) => ({ label: name, value: name })));
  const roleOptions = $derived((members?.roles ?? []).map((role) => ({ label: role, value: role })));
  let serverPreferences = $state.raw<ServerPreferences | null>(null);
  let motd = $state("");
  let defaultRole = $state("");
  let voiceBitrate = $state<number | null>(null);
  let attachmentMiB = $state<number | undefined>();
  let defaultRoleOptions = $derived([...new Set([...(serverPreferences?.defaultRoles ?? []), serverPreferences?.defaultRole ?? ""])]
    .filter(Boolean).map((role) => ({ value: role, label: role })));
  let preferencesChanged = $derived(serverPreferences && (motd.trim() !== serverPreferences.motd ||
    defaultRole !== serverPreferences.defaultRole || voiceBitrate !== serverPreferences.defaultAudioBitrate ||
    attachmentMiB !== serverPreferences.maxAttachmentMiB));
  let heading: HTMLHeadingElement;

  onMount(() => {
    heading.focus();
    if (availableTabs[0]) void selectTab(availableTabs[0].id);
  });

  function expiryTimestamp(choice: ExpiryOption): number | null {
    if (choice === "Never") return null;
    const now = new Date();
    if (choice === "1 hour") return now.getTime() + 3600000;
    if (choice === "2 hours") return now.getTime() + 7200000;
    if (choice === "3 hours") return now.getTime() + 10800000;
    if (choice === "6 hours") return now.getTime() + 21600000;
    if (choice === "12 hours") return now.getTime() + 43200000;
    if (choice === "24 hours") return now.getTime() + 86400000;
    if (choice === "1 week") return now.getTime() + 604800000;
    now.setMonth(now.getMonth() + 3);
    return now.getTime();
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    notice = "";
    try { await work(); }
    catch (reason) { error = messageFrom(reason); }
    finally { busy = false; }
  }

  async function loadMembers(nextPages: (string | undefined)[]) {
    await run(async () => {
      const response = await apiFor(origin).admin.accounts.get({ query: { after: nextPages.at(-1) } });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("accounts" in response.data)) throw requestError({ value: response.data });
      members = response.data;
      pages = nextPages;
      editingBadge = "";
    });
  }

  async function selectTab(next: Tab) {
    if (busy) return;
    tab = next;
    error = "";
    notice = "";
    if (next === "overview") {
      bannerUrl = bannerImageUrl ?? "";
      if (extended) await loadPreferences();
    }
    if (next === "roles" || next === "users") await loadMembers(pages);
    if (next === "invitation") await loadInvitations();
  }

  async function setRole(account: Roles["accounts"][number], role: string | undefined) {
    if (role === undefined || role === account.role) return;
    await run(async () => {
      const response = await apiFor(origin).admin.roles.patch({ accountId: account.id, role });
      if (response.error) throw requestError(response.error);
      if (members) {
        members = { ...members, accounts: members.accounts.map((row) => row.id === account.id ? { ...row, role } : row) };
      }
      notice = `${account.displayName} is now ${role}.`;
    });
  }

  function editBadge(account: Roles["accounts"][number]) {
    editingBadge = account.id;
    badgeDraft = account.badge ?? "";
  }

  async function toggleBan(account: Roles["accounts"][number]) {
    const banned = account.banned;
    await run(async () => {
      const ok = await workspace.memberAction({
        kind: banned ? "moderation.unban" : "moderation.ban",
        payload: { accountId: account.id },
      });
      if (!ok) throw new Error(workspace.actionError || `Could not ${banned ? "unban" : "ban"} ${account.displayName}.`);
      if (members) {
        members = { ...members, accounts: members.accounts.map((row) => row.id === account.id ? { ...row, banned: !banned } : row) };
      }
      banningAccount = "";
      notice = banned ? `Unbanned ${account.displayName}.` : `Banned ${account.displayName}.`;
    });
  }

  async function saveBadge(event: SubmitEvent, account: Roles["accounts"][number]) {
    event.preventDefault();
    await run(async () => {
      const response = await apiFor(origin).admin.badges.patch({ accountId: account.id, badge: badgeDraft.trim() || null });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("badge" in response.data)) throw requestError({ value: response.data });
      const { badge } = response.data;
      if (members) {
        members = { ...members, accounts: members.accounts.map((row) => row.id === account.id ? { ...row, badge } : row) };
      }
      editingBadge = "";
      notice = badge ? `Badge saved for ${account.displayName}.` : `Badge removed for ${account.displayName}.`;
    });
  }

  function editRole(role?: RoleDefinition) {
    deletingRole = "";
    selectedTemplate = "";
    editedRole = role?.name ?? "";
    roleName = editedRole;
    rolePermissions = [...role?.permissions ?? []];
    roleEditing = true;
  }

  function applyRoleTemplate(name: string) {
    const template = roleTemplates.find((role) => role.name === name);
    if (!template) return;
    selectedTemplate = name;
    roleName = template.name;
    rolePermissions = [...template.permissions];
  }

  function deleteRole(name: string) {
    void run(async () => {
      const response = await apiFor(origin).admin.roles.definition.delete({ name });
      if (response.error) throw requestError(response.error);
      if (members) members = { ...members, roles: members.roles.filter((role) => role !== name),
        customRoles: members.customRoles.filter((role) => role.name !== name) };
      deletingRole = "";
      notice = `Deleted ${name}.`;
    });
  }

  function applyPreferences(preferences: ServerPreferences) {
    serverPreferences = preferences;
    motd = preferences.motd;
    defaultRole = preferences.defaultRole;
    voiceBitrate = preferences.defaultAudioBitrate;
    attachmentMiB = preferences.maxAttachmentMiB;
  }

  function loadPreferences() {
    return run(async () => {
      const response = await apiFor(origin).admin.preferences.get();
      if (response.error) throw requestError(response.error);
      if (!response.data || !("motd" in response.data)) throw requestError({ value: response.data });
      applyPreferences(response.data);
    });
  }

  function savePreferences(event: SubmitEvent) {
    event.preventDefault();
    const current = serverPreferences;
    if (!current || !preferencesChanged) return;
    void run(async () => {
      const response = await apiFor(origin).admin.preferences.patch({
        motd: motd.trim() === current.motd ? undefined : motd.trim(),
        defaultRole: defaultRole === current.defaultRole ? undefined : defaultRole,
        defaultAudioBitrate: voiceBitrate === current.defaultAudioBitrate ? undefined : voiceBitrate,
        maxAttachmentMiB: attachmentMiB === current.maxAttachmentMiB ? undefined : attachmentMiB,
      });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("motd" in response.data)) throw requestError({ value: response.data });
      applyPreferences(response.data);
      notice = "Server settings saved.";
    });
  }

  function setRolePermission(permission: Permission, checked: boolean) {
    if (checked === rolePermissions.includes(permission)) return;
    rolePermissions = checked
      ? [...rolePermissions, permission]
      : rolePermissions.filter((selected) => selected !== permission);
  }

  function saveRole(event: SubmitEvent) {
    event.preventDefault();
    void run(async () => {
      const body = { name: roleName.trim(), permissions: rolePermissions };
      const api = apiFor(origin).admin.roles;
      const response = editedRole ? await api.definition.patch(body) : await api.post(body);
      if (response.error) throw requestError(response.error);
      if (!response.data || !("name" in response.data)) throw requestError({ value: response.data });
      const role = response.data;
      if (members) {
        const builtInRoles = members.builtInRoles ?? [];
        const isBuiltIn = builtInRoles.some(({ name }) => name === role.name);
        members = {
          ...members,
          roles: editedRole ? members.roles : [...members.roles, role.name],
          builtInRoles: builtInRoles.map((item) => item.name === role.name ? { ...item, permissions: role.permissions } : item),
          customRoles: isBuiltIn ? members.customRoles :
            editedRole ? members.customRoles.map((item) => item.name === role.name ? role : item) : [...members.customRoles, role],
        };
      }
      roleEditing = false;
      notice = editedRole ? `Updated permissions for ${role.name}.` : `Created ${role.name}.`;
    });
  }

  function saveBanner(event: SubmitEvent) {
    event.preventDefault();
    void run(async () => {
      const response = await apiFor(origin).admin.banner.patch({ bannerImageUrl: bannerUrl.trim() || null });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("bannerImageUrl" in response.data)) throw requestError({ value: response.data });
      bannerUrl = response.data.bannerImageUrl ?? "";
      notice = bannerUrl ? "Server banner saved." : "Server banner removed.";
    });
  }

  async function fetchInvitations() {
    const response = await apiFor(origin).admin.invitations.get();
    if (response.error) throw requestError(response.error);
    if (!response.data || !("invitations" in response.data)) throw requestError({ value: response.data });
    invitations = response.data.invitations;
  }

  function loadInvitations() {
    return run(fetchInvitations);
  }

  function editInvitation(invitation: Invitation | null) {
    editedInvitation = invitation;
    deletingInvitation = "";
    invitationLimit = invitation ? invitation.usesLeft ?? undefined : 1;
    const expiresAt = invitation?.expiresAt;
    const match = expiresAt === null ? "Never" : expiresAt === undefined ? "24 hours" : expiryOptions.slice(0, -1).find((option) => Math.abs((expiryTimestamp(option) ?? 0) - expiresAt) < 60000) ?? "24 hours";
    invitationExpiry = match;
    originalExpiryChoice = match;
  }

  function saveInvitation(event: SubmitEvent) {
    event.preventDefault();
    const editing = editedInvitation;
    if (editing && !invitationChanged) return;
    void run(async () => {
      const expiresAt = expiryChanged ? expiryTimestamp(invitationExpiry) : undefined;
      if (expiryChanged && expiresAt !== undefined && expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
        throw new Error("Choose a future expiration date.");
      }
      const api = apiFor(origin).admin.invitations;
      if (editing) {
        const response = await api({ id: editing.id }).patch({
          expiresAt: expiryChanged ? expiresAt ?? null : undefined,
          usesLeft: invitationLimit !== (editing.usesLeft ?? undefined) ? invitationLimit ?? null : undefined,
        });
        if (response.error) throw requestError(response.error);
        const updated = response.data;
        if (!updated || !("id" in updated)) throw requestError({ value: updated });
        invitations = invitations?.map((row) => row.id === updated.id ? updated : row) ?? null;
        notice = "Invitation updated.";
        editInvitation(null);
        return;
      }
      const response = await api.post({ expiresAt: expiresAt ?? undefined, uses: invitationLimit });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("token" in response.data)) throw requestError({ value: response.data });
      const { id, token } = response.data;
      createdInvitation = { id, url: `${origin}#${token}` };
      await fetchInvitations();
    });
  }

  function deleteInvitation(id: string) {
    void run(async () => {
      const response = await apiFor(origin).admin.invitations({ id }).delete();
      if (response.error) throw requestError(response.error);
      invitations = invitations?.filter((row) => row.id !== id) ?? null;
      if (createdInvitation?.id === id) createdInvitation = null;
      if (editedInvitation?.id === id) editInvitation(null);
      deletingInvitation = "";
      notice = "Invitation deleted.";
    });
  }

  function copyInvitation(url: string) {
    void run(async () => {
      try {
        await navigator.clipboard.writeText(url);
        notice = "Invitation link copied.";
      } catch {
        throw new Error("Could not copy automatically. Select and copy the invitation link.");
      }
    });
  }

  function invitationStatus(invitation: Invitation) {
    if (invitation.expiresAt !== null && invitation.expiresAt <= Date.now()) return "Expired";
    if (invitation.usesLeft === 0) return "Out of uses";
    return "Active";
  }
</script>

<header class="workspace-header">
  <div class="heading-icon"><Settings2 size={19} aria-hidden="true" /></div>
  <div class="flex-content">
    <div class="breadcrumb truncate">{title}</div>
    <h2 bind:this={heading} tabindex="-1">Server settings</h2>
  </div>
  <IconButton label="Back to chat" disabled={busy} onclick={onclose}><X size={18} aria-hidden="true" /></IconButton>
</header>

<div class="workspace">
  <div class="server-admin">
    <div class="admin-tabs" aria-label="Administration sections">
      {#each availableTabs as section (section.id)}
        <Button variant="outline" aria-pressed={tab === section.id} disabled={busy} onclick={() => selectTab(section.id)}>
          {section.label}
        </Button>
      {/each}
    </div>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="field-hint" role="status">{notice}</p>{/if}
    {#if busy}<p class="field-hint" role="status">Working…</p>{/if}

    {#if tab === "overview" && permissions.includes("manageSettings") && (extended || bannerSupported)}
      {#if extended}
        {#if serverPreferences}
          <form class="dialog-form" onsubmit={savePreferences}>
            <label>Message of the day
              <Textarea rows={4} maxlength={1000} disabled={busy} bind:value={motd} placeholder="Leave blank to hide the message" />
            </label>
            <p class="field-hint">Appears above the chat for connected members.</p>
            {#if serverPreferences.audioBitrateLocked}
              <VoiceBitrateField label="Default voice bitrate" defaultLabel="Server configuration"
                defaultBitrate={serverPreferences.configuredAudioBitrate} value={null} disabled />
            {:else}
              <VoiceBitrateField label="Default voice bitrate" defaultLabel="Server configuration"
                defaultBitrate={serverPreferences.configuredAudioBitrate} savedBitrate={serverPreferences.defaultAudioBitrate}
                bind:value={voiceBitrate} disabled={busy} />
            {/if}
            <p class="field-hint">{serverPreferences.audioBitrateLocked ? "The server environment sets this value." :
              "Used by voice channels that inherit the default."}</p>
            {#if serverPreferences.maxSupportedAttachmentMiB !== undefined}
              <label>Maximum chat attachment size (MiB)
                <Input type="number" min="1" max={serverPreferences.maxSupportedAttachmentMiB} step="1" required
                  disabled={busy} bind:value={attachmentMiB} />
              </label>
            {/if}
            <SelectField label="Default role for new members" options={defaultRoleOptions} bind:value={defaultRole}
              disabled={busy || !serverPreferences.canSetDefaultRole || defaultRoleOptions.length < 2} />
            <p class="field-hint">New accounts get this role when they register.</p>
            <div class="dialog-actions">
              <Button variant="default" type="submit" disabled={busy || !preferencesChanged}>Save settings</Button>
            </div>
          </form>
        {:else if !busy}
          <Button variant="outline" onclick={loadPreferences}>Load server settings</Button>
        {/if}
      {/if}
      {#if bannerSupported}
        <form class="dialog-form" onsubmit={saveBanner}>
          <label>Banner image URL<Input type="url" pattern="https://.+" maxlength={512} placeholder="https://example.com/banner.jpg"
            disabled={busy} bind:value={bannerUrl} /></label>
          <p class="field-hint">Clear the URL to remove the banner.</p>
          <div class="dialog-actions"><Button variant="default" type="submit" disabled={busy}>Save banner</Button></div>
        </form>
      {/if}
    {:else if tab === "audit" && extended && permissions.includes("viewAdmin")}
      <ServerAuditLog {origin} />
    {:else if tab === "roles" && permissions.includes("manageRoles")}
      {#if members}
        {#if members.canDefineRoles}
          <section class="role-settings" aria-label="Role definitions">
            <div class="role-heading">
              <h3>{roleEditing ? editedRole ? `Edit ${editedRole}` : "Create role" : "Role permissions"}</h3>
              {#if !roleEditing}<Button variant="outline" disabled={busy} onclick={() => editRole()}>Create role</Button>{/if}
            </div>
            {#if roleEditing}
              <form class="dialog-form" onsubmit={saveRole}>
                {#if !editedRole}
                  <SelectField label="Start from a template" placeholder="Choose a template (optional)" options={templateOptions}
                    disabled={busy} bind:value={() => selectedTemplate, applyRoleTemplate} />
                  <label>Role name<Input required maxlength={80} disabled={busy} bind:value={roleName} /></label>
                {/if}
                {#if editingDefaultRole}
                  <p class="field-hint">New accounts receive this role. Choose a different default in Overview to grant channel management, moderation, or administration permissions.</p>
                {/if}
                {#if members.assignablePermissions.includes("shareScreen")}
                  <p class="field-hint">Screen sharing, camera, and whispering also require voice access. Attachments require channel chat access.</p>
                {/if}
                <div class="permission-groups">
                  {#each permissionGroups as group (group.label)}
                    {@const options = group.permissions.filter((permission) => members?.assignablePermissions.includes(permission))}
                    {#if options.length}
                      <fieldset class="permission-group" disabled={busy}>
                        <legend>{group.label}</legend>
                        {#each options as permission (permission)}
                          <Checkbox label={permissionLabels[permission]}
                            disabled={busy || (editingDefaultRole && !members.registrationPermissions?.includes(permission))}
                            bind:checked={() => rolePermissions.includes(permission), (checked) => setRolePermission(permission, checked)} />
                        {/each}
                      </fieldset>
                    {/if}
                  {/each}
                </div>
                <div class="dialog-actions">
                  {#if roleDefaults}
                    <Button variant="outline" type="button" disabled={busy}
                      onclick={() => { rolePermissions = [...roleDefaults]; }}>Restore defaults</Button>
                  {/if}
                  <Button variant="outline" type="button" disabled={busy} onclick={() => { roleEditing = false; }}>Cancel</Button>
                  <Button variant="default" type="submit" disabled={busy}>{editedRole ? "Save permissions" : "Create role"}</Button>
                </div>
              </form>
            {:else}
              {#if members.builtInRoles?.length}
                <h4>Built-in roles</h4>
                <ul class="role-list">
                  {#each members.builtInRoles as role (role.name)}
                    <li>
                      <div>
                        <strong>{role.name}</strong>
                        {#if members.defaultRole === role.name}<p class="field-hint">Default for new accounts</p>{/if}
                      </div>
                      {#if role.editable}
                        <Button variant="outline" aria-label={`Edit permissions for ${role.name}`} disabled={busy} onclick={() => editRole(role)}>Edit</Button>
                      {:else}
                        <span class="field-hint">Full server access</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              <h4>Custom roles</h4>
              {#if members.customRoles.length}
                <ul class="role-list">
                  {#each members.customRoles as role (role.name)}
                    <li>
                      <div class="shrinkable">
                        <strong class="truncate" title={role.name}>{role.name}</strong>
                        {#if members.defaultRole === role.name}<p class="field-hint">Default for new accounts</p>{/if}
                      </div>
                      <div class="dialog-actions">
                        {#if deletingRole === role.name}
                          <Button variant="outline" disabled={busy} onclick={() => { deletingRole = ""; }}>Cancel</Button>
                          <Button variant="default" disabled={busy} onclick={() => deleteRole(role.name)}>Confirm deletion</Button>
                        {:else}
                          <Button variant="outline" aria-label={`Edit permissions for ${role.name}`} disabled={busy} onclick={() => editRole(role)}>Edit</Button>
                          {#if extended}
                            <Button variant="outline" aria-label={`Delete ${role.name}`} disabled={busy} onclick={() => { deletingRole = role.name; }}>Delete</Button>
                          {/if}
                        {/if}
                      </div>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="field-hint">No custom roles yet.</p>
              {/if}
            {/if}
          </section>
        {:else}
          <p class="field-hint">You can view and assign member roles from the Users tab.</p>
        {/if}
      {:else if !busy}
        <Button variant="outline" onclick={() => loadMembers(pages)}>Load roles</Button>
      {/if}
    {:else if tab === "users" && permissions.includes("manageRoles")}
      {#if members}
        <ul class="admin-members">
          {#each members.accounts as account (account.id)}
            <li>
              <span class="shrinkable">
                <strong class="truncate" title={account.displayName}>{account.displayName}</strong>
                {#if account.badge}<span class="member-badge" title={account.badge}>{account.badge}</span>{/if}
                {#if account.banned}<span class="member-badge banned-tag">Banned</span>{/if}
                <small class="field-hint">{account.id}</small>
              </span>
              {#if account.editable}
                <SelectField label={`Role for ${account.displayName} (${account.id})`} hideLabel
                  options={members.roles.includes(account.role) ? roleOptions
                    : [{ label: account.role, value: account.role, disabled: true }, ...roleOptions]}
                  disabled={busy || !roleOptions.length}
                  bind:value={() => account.role, (role) => void setRole(account, role)} />
              {:else}
                <span>{account.role}</span>
              {/if}
              {#if account.editable && account.badge !== undefined}
                {#if editingBadge === account.id}
                  <form class="badge-form" onsubmit={(event) => saveBadge(event, account)}>
                    <label>Badge for {account.displayName}<Input bind:value={badgeDraft} maxlength={32} disabled={busy} /></label>
                    <p class="field-hint">Clear the label to remove the badge.</p>
                    <div class="dialog-actions">
                      <Button variant="outline" type="button" disabled={busy} onclick={() => { editingBadge = ""; }}>Cancel</Button>
                      <Button type="submit" disabled={busy || (badgeDraft.trim() || null) === account.badge}>Save badge</Button>
                    </div>
                  </form>
                {:else}
                  <Button variant="outline" disabled={busy} aria-label={`${account.badge ? "Edit" : "Set"} badge for ${account.displayName}`}
                    onclick={() => editBadge(account)}>{account.badge ? "Edit badge" : "Set badge"}</Button>
                {/if}
              {/if}
              {#if account.bannable}
                {#if banningAccount === account.id}
                  <Button variant="outline" disabled={busy} onclick={() => { banningAccount = ""; }}>Cancel</Button>
                  <Button variant="default" disabled={busy} onclick={() => toggleBan(account)}>
                    {account.banned ? "Confirm unban" : "Confirm ban"}
                  </Button>
                {:else}
                  <Button variant="outline" disabled={busy} aria-label={`${account.banned ? "Unban" : "Ban"} ${account.displayName}`}
                    onclick={() => { banningAccount = account.id; }}>{account.banned ? "Unban" : "Ban"}</Button>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
        {#if pages.length > 1 || members.next}
          <div class="dialog-actions">
            <Button variant="outline" disabled={busy || pages.length < 2} onclick={() => loadMembers(pages.slice(0, -1))}>Previous</Button>
            <Button variant="outline" disabled={busy || !members.next} onclick={() => loadMembers([...pages, members?.next ?? undefined])}>Next</Button>
          </div>
        {/if}
      {:else if !busy}
        <Button variant="outline" onclick={() => loadMembers(pages)}>Load users</Button>
      {/if}
    {:else if tab === "invitation" && permissions.includes("manageInvitations")}
      <form class="dialog-form" onsubmit={saveInvitation}>
        <section class="invite-panel">
        <div class="invite-heading"><div><h3>{editedInvitation ? `Edit invitation ${editedInvitation.id.slice(0, 8)}` : "Create an invitation"}</h3><p class="field-hint">Choose how many people can join and when this link expires.</p></div></div>
        <label>{editedInvitation ? "Remaining uses" : "Use limit"}
          <Input type="number" min={editedInvitation ? 0 : 1} max="10000" placeholder="Unlimited" disabled={busy} bind:value={invitationLimit} />
        </label>
        <SelectField label="Expires after" options={expirySelectOptions} disabled={busy} bind:value={invitationExpiry} />
        <p class="field-hint">Leave the use limit blank for unlimited uses. Three months is calculated from today.</p>
        <div class="dialog-actions">
          {#if editedInvitation}
            <Button variant="outline" type="button" disabled={busy} onclick={() => editInvitation(null)}>Cancel</Button>
          {/if}
          <Button variant="default" type="submit"
            disabled={busy || Boolean(editedInvitation && !invitationChanged)}>
            {editedInvitation ? "Save changes" : "Create invitation"}
          </Button>
        </div>
        </section>
      </form>
      {#if createdInvitation}
        {@const url = createdInvitation.url}
        <div class="dialog-form invite-link">
          <label>Invitation link<Input value={url} readonly /></label>
          <p class="field-hint">Copy this link before creating another invitation or leaving server settings.</p>
          <Button variant="outline" class="fit-action" disabled={busy} onclick={() => copyInvitation(url)}>Copy link</Button>
        </div>
      {/if}
      <section class="existing-invites"><div class="section-heading"><div><h3>Existing invitations</h3></div><span class="invite-count">{invitations?.length ?? 0}</span></div>
      {#if invitations?.length}
        <ul class="admin-members">
          {#each invitations as invitation (invitation.id)}
            {@const label = `Invitation ${invitation.id.slice(0, 8)}`}
            <li>
              <div>
                <strong>{label}</strong>
                <p class="field-hint">
                  {invitationStatus(invitation)} · {invitation.usesLeft === null ? "Unlimited uses" : `${invitation.usesLeft} remaining`}
                  · {invitation.expiresAt === null ? "No expiration" : new Date(invitation.expiresAt).toLocaleString()}
                </p>
              </div>
              <div class="dialog-actions">
                {#if deletingInvitation === invitation.id}
                  <Button variant="outline" disabled={busy} onclick={() => { deletingInvitation = ""; }}>Cancel</Button>
                  <Button variant="default" disabled={busy} onclick={() => deleteInvitation(invitation.id)}>Confirm deletion</Button>
                {:else}
                  <Button variant="outline" aria-label={`Edit ${label.toLowerCase()}`} disabled={busy} onclick={() => editInvitation(invitation)}>Edit</Button>
                  <Button variant="outline" aria-label={`Delete ${label.toLowerCase()}`} disabled={busy} onclick={() => { deletingInvitation = invitation.id; }}>Delete</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else if invitations}
        <p class="field-hint">No invitations yet.</p>
      {:else if !busy}
        <Button variant="outline" class="fit-action" onclick={loadInvitations}>Load invitations</Button>
      {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .badge-form { width: 100%; display: grid; gap: .4rem; }
  .badge-form label { display: grid; gap: .25rem; }
  .banned-tag { border-color: color-mix(in srgb, var(--destructive) 40%, var(--border)); background: color-mix(in srgb, var(--destructive) 12%, transparent); color: var(--destructive); }
  .role-settings { margin-block-end: 1rem; }
  .role-settings h4 { margin-block-start: .4rem; font-weight: 600; }
  .role-list { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); }
  .role-list li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .6rem; padding: .55rem .75rem; }
  .role-list li + li { border-block-start: 1px solid var(--border); }
  .permission-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: .75rem; }
  .permission-group { display: flex; flex-direction: column; gap: .55rem; padding: .65rem .75rem; border: 1px solid var(--border); border-radius: var(--radius-md); }
  .permission-group legend { padding-inline: .25rem; font-weight: 600; }
  .invite-panel, .existing-invites { display: grid; gap: 1rem; padding: var(--ui-gap); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
  .invite-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .invite-heading h3, .section-heading h3 { margin: .2rem 0; }
  .invite-count { min-width: 2rem; height: 2rem; display: grid; place-items: center; border-radius: var(--radius-md); background: var(--muted); color: var(--muted-foreground); }
  .invite-link { padding: var(--ui-gap); border: 1px solid var(--border); border-radius: var(--radius-md); }

</style>
