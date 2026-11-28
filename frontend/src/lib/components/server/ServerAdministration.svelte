<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import VoiceBitrateField from "#lib/components/fields/VoiceBitrateField.svelte";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { onMount, untrack } from "svelte";
  import { Search, Settings2, X } from "@lucide/svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import ServerAuditLog from "./ServerAuditLog.svelte";
  import { apiFor, messageFrom, requestError } from "#lib/connection/client";
  import { getWorkspace } from "#lib/workspace";
  import { banDurationOptions, banDurations, banPayload, type BanDuration } from "#lib/ban-duration";
  import { permissionLabels as sharedPermissionLabels } from "#lib/permissions";

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
  const permissionLabels: Record<Permission, string> = sharedPermissionLabels;
  const permissionGroups = [
    { label: "Channel access and voice", permissions: ["join", "speak", "shareScreen", "useCamera", "whisper"] },
    { label: "Messaging", permissions: ["text", "attachFiles", "sendDirectMessages", "deleteChannels", "pinMessages"] },
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
  let savedBannerUrl = $state("");
  let bannerChanged = $derived(bannerSupported && bannerUrl.trim() !== savedBannerUrl);
  let roleEditing = $state(false);
  let editedRole = $state("");
  let editingBadge = $state("");
  let badgeDraft = $state("");
  let banningAccount = $state("");
  let banDuration = $state<BanDuration>("never");
  let deletingRole = $state("");
  let roleName = $state("");
  let selectedTemplate = $state("");
  let rolePermissions = $state<Permission[]>([]);
  let roleMentionable = $state(false);
  const roleDefaults = $derived(members?.builtInRoles?.find(({ name }) => name === editedRole)?.defaultPermissions);
  const editingDefaultRole = $derived(Boolean(editedRole && editedRole === members?.defaultRole));
  const templateOptions = $derived(roleTemplates.filter(({ permissions }) =>
    permissions.every((permission) => members?.assignablePermissions.includes(permission)))
    .map(({ name }) => ({ label: name, value: name })));
  const roleOptions = $derived((members?.roles ?? []).map((role) => ({ label: role, value: role })));

  type RoleRow = RoleDefinition & { builtIn: boolean; editable: boolean; deletable: boolean };
  let roleSearch = $state("");
  let roleFilter = $state<Permission | "any">("any");
  /** Built-in roles first, in rank order, then custom roles in the order the server lists them. */
  const roleRows = $derived<RoleRow[]>(members ? [
    ...(members.builtInRoles ?? []).map((role) => ({ ...role, builtIn: true, deletable: false })),
    ...members.customRoles.map((role) => ({ ...role, builtIn: false, editable: true, deletable: extended })),
  ] : []);
  const visibleRoles = $derived.by(() => {
    const term = roleSearch.trim().toLocaleLowerCase();
    return roleRows.filter((role) => (!term || role.name.toLocaleLowerCase().includes(term)) &&
      (roleFilter === "any" || role.permissions.includes(roleFilter)));
  });
  const permissionFilterOptions = $derived([
    { value: "any" as const, label: "Any permission" },
    ...permissionGroups.flatMap(({ permissions }) => permissions)
      .filter((permission) => roleRows.some((role) => role.permissions.includes(permission)))
      .map((permission) => ({ value: permission, label: permissionLabels[permission] })),
  ]);
  const totalPermissions = $derived(Math.max(members?.assignablePermissions.length ?? 0,
    ...roleRows.map(({ permissions }) => permissions.length)));

  type UserStatus = "all" | "active" | "banned";
  let userSearch = $state("");
  let userRole = $state("any");
  let userStatus = $state<UserStatus>("all");
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  const usersFiltered = $derived(Boolean(userSearch.trim()) || userRole !== "any" || userStatus !== "all");
  const userRoleOptions = $derived([
    { value: "any", label: "All roles" },
    ...(members?.allRoles ?? members?.roles ?? []).map((role) => ({ value: role, label: role })),
  ]);
  const userStatusOptions: { value: UserStatus; label: string }[] = [
    { value: "all", label: "Any status" },
    { value: "active", label: "Not banned" },
    { value: "banned", label: "Banned" },
  ];
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
    return () => clearTimeout(filterTimer);
  });

  function memberQuery(after: string | undefined) {
    return {
      after,
      search: userSearch.trim() || undefined,
      role: userRole === "any" ? undefined : userRole,
      status: userStatus === "all" ? undefined : userStatus,
    };
  }

  /** Reloads the first page with the current filters, waiting out any request already running. */
  function filterUsers(delay = 0) {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (busy) filterUsers(100);
      else void loadMembers([undefined]);
    }, delay);
  }

  function clearUserFilters() {
    userSearch = "";
    userRole = "any";
    userStatus = "all";
    filterUsers();
  }

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
      const response = await apiFor(origin).admin.accounts.get({ query: memberQuery(nextPages.at(-1)) });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("accounts" in response.data)) throw requestError({ value: response.data });
      members = response.data;
      pages = nextPages;
      editingBadge = "";
    });
  }

  /** Reloads the open page in the background, leaving notices and any badge being edited alone. */
  async function refreshMembers() {
    const response = await apiFor(origin).admin.accounts.get({ query: memberQuery(pages.at(-1)) });
    if (!response.error && response.data && "accounts" in response.data) members = response.data;
  }

  // The server bumps this whenever any account's roles change, including changes made elsewhere.
  const accountsRevision = $derived(workspace.view.snapshot?.accountsRevision);
  let seenAccountsRevision: number | undefined;
  $effect(() => {
    const revision = accountsRevision;
    if (revision === undefined || revision === seenAccountsRevision) return;
    const first = seenAccountsRevision === undefined;
    seenAccountsRevision = revision;
    untrack(() => {
      if (!first && members && (tab === "users" || tab === "roles")) void refreshMembers();
    });
  });

  async function selectTab(next: Tab) {
    if (busy) return;
    tab = next;
    error = "";
    notice = "";
    if (next === "overview") {
      bannerUrl = savedBannerUrl = bannerImageUrl ?? "";
      if (extended) await loadPreferences();
    }
    if (next === "roles" || next === "users") await loadMembers(pages);
    if (next === "invitation") await loadInvitations();
  }

  const baseRoles = ["Guest", "Member"];
  function heldRoles(account: Roles["accounts"][number]) {
    return account.roles ?? [account.role];
  }
  /** Every account keeps Guest or Member, and only roles below the caller can be removed. */
  function removable(account: Roles["accounts"][number], role: string) {
    const held = heldRoles(account);
    return account.editable && !!members?.roles.includes(role) &&
      !(baseRoles.includes(role) && !held.some((other) => other !== role && baseRoles.includes(other)));
  }

  async function changeRole(account: Roles["accounts"][number], role: string | undefined, add: boolean) {
    if (role === undefined || heldRoles(account).includes(role) === add) return;
    await run(async () => {
      const body = { accountId: account.id, role };
      const api = apiFor(origin).admin.accounts.roles;
      const response = add ? await api.post(body) : await api.delete(body);
      if (response.error) throw requestError(response.error);
      const roles = response.data.roles;
      if (members) {
        members = { ...members, accounts: members.accounts.map((row) => row.id === account.id ? { ...row, roles, role: roles[0] ?? row.role } : row) };
      }
      notice = add ? `${account.displayName} now has the ${role} role.` : `${account.displayName} no longer has the ${role} role.`;
    });
  }

  function editBadge(account: Roles["accounts"][number]) {
    editingBadge = account.id;
    badgeDraft = account.badge ?? "";
  }

  async function toggleBan(account: Roles["accounts"][number]) {
    const banned = account.banned;
    await run(async () => {
      const seconds = banned ? undefined : banDurations[banDuration].seconds;
      const ok = await workspace.memberAction(banned
        ? { kind: "moderation.unban", payload: { accountId: account.id } }
        : { kind: "moderation.ban", payload: banPayload(account.id, banDuration) });
      if (!ok) throw new Error(workspace.actionError || `Could not ${banned ? "unban" : "ban"} ${account.displayName}.`);
      if (members) {
        const bannedUntil = seconds === undefined ? null : Date.now() + seconds * 1000;
        members = { ...members, accounts: members.accounts.map((row) => row.id === account.id ? { ...row, banned: !banned, bannedUntil } : row) };
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
    roleMentionable = role?.mentionable ?? false;
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

  function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    const current = serverPreferences;
    const savePreferences = Boolean(current && preferencesChanged);
    const saveBanner = bannerChanged;
    if (!savePreferences && !saveBanner) return;
    void run(async () => {
      if (current && savePreferences) {
        const response = await apiFor(origin).admin.preferences.patch({
          motd: motd.trim() === current.motd ? undefined : motd.trim(),
          defaultRole: defaultRole === current.defaultRole ? undefined : defaultRole,
          defaultAudioBitrate: voiceBitrate === current.defaultAudioBitrate ? undefined : voiceBitrate,
          maxAttachmentMiB: attachmentMiB === current.maxAttachmentMiB ? undefined : attachmentMiB,
        });
        if (response.error) throw requestError(response.error);
        if (!response.data || !("motd" in response.data)) throw requestError({ value: response.data });
        applyPreferences(response.data);
      }
      if (saveBanner) {
        const response = await apiFor(origin).admin.banner.patch({ bannerImageUrl: bannerUrl.trim() || null });
        if (response.error) throw requestError(response.error);
        if (!response.data || !("bannerImageUrl" in response.data)) throw requestError({ value: response.data });
        bannerUrl = savedBannerUrl = response.data.bannerImageUrl ?? "";
      }
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
      const body = { name: roleName.trim(), permissions: rolePermissions, mentionable: roleMentionable };
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
          builtInRoles: builtInRoles.map((item) => item.name === role.name ? { ...item, permissions: role.permissions, mentionable: role.mentionable } : item),
          customRoles: isBuiltIn ? members.customRoles :
            editedRole ? members.customRoles.map((item) => item.name === role.name ? role : item) : [...members.customRoles, role],
        };
      }
      roleEditing = false;
      notice = editedRole ? `Updated permissions for ${role.name}.` : `Created ${role.name}.`;
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

{#snippet panelHeading(title: string, hint: string)}
  <div class="panel-heading"><div><h3>{title}</h3><p class="field-hint">{hint}</p></div></div>
{/snippet}

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
      {#if extended && !serverPreferences && !busy}
        <Button variant="outline" onclick={loadPreferences}>Load server settings</Button>
      {/if}
      {#if (extended && serverPreferences) || bannerSupported}
        <form class="dialog-form admin-form" onsubmit={saveSettings}>
          {#if extended && serverPreferences}
            <section class="admin-panel">
              {@render panelHeading("General", "What members see when they connect, and the role new accounts start with.")}
              <label>Message of the day
                <Textarea rows={4} maxlength={1000} disabled={busy} bind:value={motd} placeholder="Leave blank to hide the message" />
              </label>
              <p class="field-hint">Appears above the chat for connected members.</p>
              <SelectField label="Default role for new members" options={defaultRoleOptions} bind:value={defaultRole}
                disabled={busy || !serverPreferences.canSetDefaultRole || defaultRoleOptions.length < 2} />
              <p class="field-hint">New accounts get this role when they register.</p>
            </section>
            <section class="admin-panel">
              {@render panelHeading("Voice and chat", "Defaults for voice quality and file uploads.")}
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
            </section>
          {/if}
          {#if bannerSupported}
            <section class="admin-panel">
              {@render panelHeading("Appearance", "The image shown at the top of the channel list.")}
              <label>Banner image URL<Input type="url" pattern="https://.+" maxlength={512} placeholder="https://example.com/banner.jpg"
                disabled={busy} bind:value={bannerUrl} /></label>
              <p class="field-hint">Clear the URL to remove the banner.</p>
            </section>
          {/if}
          <div class="dialog-actions">
            <Button variant="default" type="submit" disabled={busy || (!preferencesChanged && !bannerChanged)}>Save settings</Button>
          </div>
        </form>
      {/if}
    {:else if tab === "audit" && extended && permissions.includes("viewAdmin")}
      <ServerAuditLog {origin} />
    {:else if tab === "roles" && permissions.includes("manageRoles")}
      {#if members}
        {#if members.canDefineRoles}
          {#if !roleEditing}
            <div class="admin-toolbar">
              <label class="search-field">
                <span class="sr-only">Search roles</span>
                <Search size={16} aria-hidden="true" />
                <Input type="search" placeholder="Search roles" bind:value={roleSearch} />
              </label>
              <SelectField label="Filter roles by permission" hideLabel options={permissionFilterOptions}
                bind:value={roleFilter} />
            </div>
          {/if}
          <section class="admin-panel" aria-label="Role definitions">
            {#if roleEditing}
              {@render panelHeading(editedRole ? `Edit ${editedRole}` : "Create a role",
                editedRole ? "Choose what members with this role can do." : "Start from a template or pick permissions yourself.")}
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
                <Checkbox label="Allow anyone to @mention this role" disabled={busy} bind:checked={roleMentionable} />
                <p class="field-hint">Members holding the role hear a sound when someone mentions it.</p>
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
              <div class="panel-heading">
                <h3>Roles</h3>
                <div class="panel-heading-actions">
                  <span class="panel-count" title="Roles">{roleRows.length}</span>
                  <Button variant="outline" disabled={busy} onclick={() => editRole()}>Create role</Button>
                </div>
              </div>
              {#if visibleRoles.length < roleRows.length}
                <p class="field-hint" role="status">Showing {visibleRoles.length} of {roleRows.length} roles.</p>
              {/if}
              {#if visibleRoles.length}
                <ul class="admin-members">
                  {#each visibleRoles as role (role.name)}
                    <li>
                      <div class="shrinkable role-summary">
                        <div class="role-title">
                          <strong class="truncate" title={role.name}>{role.name}</strong>
                          <span class="member-badge">{role.builtIn ? "Built-in" : "Custom"}</span>
                          {#if members.defaultRole === role.name}<span class="member-badge member-role">Default</span>{/if}
                        </div>
                        <p class="field-hint">
                          {role.permissions.length === totalPermissions ? "All permissions" :
                            `${role.permissions.length} of ${totalPermissions} permissions`}
                          {#if roleFilter !== "any"} · includes {permissionLabels[roleFilter].toLocaleLowerCase()}{/if}
                        </p>
                      </div>
                      <div class="dialog-actions">
                        {#if deletingRole === role.name}
                          <Button variant="outline" disabled={busy} onclick={() => { deletingRole = ""; }}>Cancel</Button>
                          <Button variant="destructive" disabled={busy} onclick={() => deleteRole(role.name)}>Confirm deletion</Button>
                        {:else}
                          {#if role.editable}
                            <Button variant="outline" aria-label={`Edit permissions for ${role.name}`} disabled={busy} onclick={() => editRole(role)}>Edit</Button>
                          {:else}
                            <span class="field-hint">Not editable</span>
                          {/if}
                          {#if role.deletable}
                            <Button variant="outline" aria-label={`Delete ${role.name}`} disabled={busy} onclick={() => { deletingRole = role.name; }}>Delete</Button>
                          {/if}
                        {/if}
                      </div>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="field-hint">No roles match.</p>
              {/if}
            {/if}
          </section>
        {:else}
          <section class="admin-panel">
            {@render panelHeading("Roles", "You can view and assign member roles from the Users tab.")}
          </section>
        {/if}
      {:else if !busy}
        <Button variant="outline" onclick={() => loadMembers(pages)}>Load roles</Button>
      {/if}
    {:else if tab === "users" && permissions.includes("manageRoles")}
      <div class="admin-toolbar">
        <label class="search-field">
          <span class="sr-only">Search users</span>
          <Search size={16} aria-hidden="true" />
          <Input type="search" placeholder="Search by name or account ID" maxlength={100}
            bind:value={userSearch} oninput={() => filterUsers(250)} />
        </label>
        <SelectField label="Filter users by role" hideLabel options={userRoleOptions} disabled={!members}
          bind:value={() => userRole, (role) => { if (role === userRole) return; userRole = role; filterUsers(); }} />
        <SelectField label="Filter users by ban status" hideLabel options={userStatusOptions} disabled={!members}
          bind:value={() => userStatus, (status) => { if (status === userStatus) return; userStatus = status; filterUsers(); }} />
        {#if usersFiltered}
          <Button variant="ghost" onclick={clearUserFilters}>Clear filters</Button>
        {/if}
      </div>
      <section class="admin-panel" aria-label="Users">
      <div class="panel-heading">
        <h3>Users</h3>
        {#if members}<span class="panel-count" title="Users on this page">{members.accounts.length}{members.next ? "+" : ""}</span>{/if}
      </div>
      {#if members}
        {#if !members.accounts.length}
          <p class="field-hint">{usersFiltered ? "No users match these filters." : "No users yet."}</p>
        {/if}
        <ul class="admin-members user-list">
          {#each members.accounts as account (account.id)}
            {@const addable = account.editable ? roleOptions.filter(({ value }) => !heldRoles(account).includes(value)) : []}
            <li>
              <Avatar name={account.displayName} accountId={account.id} small />
              <div class="shrinkable user-details">
                <div class="role-title">
                  <strong class="truncate" title={account.displayName}>{account.displayName}</strong>
                  {#if account.badge}<span class="member-badge" title={account.badge}>{account.badge}</span>{/if}
                  {#if account.banned}
                    <span class="member-badge banned-tag" title={account.bannedUntil ? `Banned until ${new Date(account.bannedUntil).toLocaleString()}` : "Banned permanently"}>
                      {account.bannedUntil ? `Banned until ${new Date(account.bannedUntil).toLocaleDateString()}` : "Banned"}
                    </span>
                  {/if}
                </div>
                <small class="field-hint">{account.id}</small>
                <div class="role-chips" aria-label={`Roles for ${account.displayName}`}>
                  {#each heldRoles(account) as role (role)}
                    <span class="member-badge member-role role-chip">
                      {role}
                      {#if removable(account, role)}
                        <button type="button" class="role-chip-remove" disabled={busy}
                          aria-label={`Remove ${role} from ${account.displayName}`} title={`Remove ${role}`}
                          onclick={() => void changeRole(account, role, false)}><X /></button>
                      {/if}
                    </span>
                  {/each}
                  {#if addable.length}
                    <div class="add-role">
                      <SelectField label={`Add a role for ${account.displayName} (${account.id})`} hideLabel placeholder="Add role"
                        options={addable} disabled={busy}
                        bind:value={() => undefined, (role) => void changeRole(account, role, true)} />
                    </div>
                  {/if}
                </div>
              </div>
              <div class="dialog-actions user-actions">
                {#if account.editable && account.badge !== undefined && editingBadge !== account.id}
                  <Button variant="outline" disabled={busy} aria-label={`${account.badge ? "Edit" : "Set"} badge for ${account.displayName}`}
                    onclick={() => editBadge(account)}>{account.badge ? "Edit badge" : "Set badge"}</Button>
                {/if}
                {#if account.bannable && banningAccount !== account.id}
                  <Button variant={account.banned ? "outline" : "destructive"} disabled={busy}
                    aria-label={`${account.banned ? "Unban" : "Ban"} ${account.displayName}`}
                    onclick={() => { banningAccount = account.id; banDuration = "never"; }}>{account.banned ? "Unban" : "Ban"}</Button>
                {/if}
              </div>
              {#if account.editable && account.badge !== undefined && editingBadge === account.id}
                <form class="user-panel" onsubmit={(event) => saveBadge(event, account)}>
                  <label>Badge for {account.displayName}<Input bind:value={badgeDraft} maxlength={32} disabled={busy} /></label>
                  <p class="field-hint">Clear the label to remove the badge.</p>
                  <div class="dialog-actions">
                    <Button variant="outline" type="button" disabled={busy} onclick={() => { editingBadge = ""; }}>Cancel</Button>
                    <Button type="submit" disabled={busy || (badgeDraft.trim() || null) === account.badge}>Save badge</Button>
                  </div>
                </form>
              {/if}
              {#if account.bannable && banningAccount === account.id}
                <div class="user-panel" role="group" aria-label={`${account.banned ? "Unban" : "Ban"} ${account.displayName}`}>
                  {#if account.banned}
                    <p>Allow {account.displayName} to connect again?</p>
                  {:else}
                    <SelectField label={`Ban ${account.displayName} for`} options={banDurationOptions} disabled={busy} bind:value={banDuration} />
                    <p class="field-hint">They are disconnected and cannot sign in until the ban ends.</p>
                  {/if}
                  <div class="dialog-actions">
                    <Button variant="outline" disabled={busy} onclick={() => { banningAccount = ""; }}>Cancel</Button>
                    <Button variant={account.banned ? "default" : "destructive"} disabled={busy} onclick={() => toggleBan(account)}>
                      {account.banned ? "Confirm unban" : "Confirm ban"}
                    </Button>
                  </div>
                </div>
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
        <Button variant="outline" class="fit-action" onclick={() => loadMembers(pages)}>Load users</Button>
      {/if}
      </section>
    {:else if tab === "invitation" && permissions.includes("manageInvitations")}
      <form class="dialog-form" onsubmit={saveInvitation}>
        <section class="admin-panel">
        {@render panelHeading(editedInvitation ? `Edit invitation ${editedInvitation.id.slice(0, 8)}` : "Create an invitation",
          "Choose how many people can join and when this link expires.")}
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
      <section class="admin-panel"><div class="panel-heading"><div><h3>Existing invitations</h3></div><span class="panel-count">{invitations?.length ?? 0}</span></div>
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
  .admin-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .admin-toolbar > :global(*) { flex: 1 1 11rem; }
  .admin-toolbar > :global(button) { flex: none; }
  .search-field { position: relative; display: flex; align-items: center; flex: 2 1 16rem; }
  .search-field > :global(svg) { position: absolute; inset-inline-start: .6rem; color: var(--muted-foreground); pointer-events: none; }
  .search-field > :global(input) { padding-inline-start: 2rem; }
  .role-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
  .role-summary { display: grid; gap: 2px; }
  .user-list li { flex-wrap: wrap; align-items: flex-start; justify-content: flex-start; gap: 10px; padding: 10px 4px; }
  .user-details { display: grid; flex: 1 1 14rem; gap: 4px; }
  .user-actions { margin-inline-start: auto; }
  .add-role { min-width: 8.5rem; }
  .user-panel { display: grid; flex-basis: 100%; gap: .5rem; padding: .65rem .75rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); }
  .user-panel label { display: grid; gap: .25rem; }
  .banned-tag { border-color: color-mix(in srgb, var(--destructive) 40%, var(--border)); background: color-mix(in srgb, var(--destructive) 12%, transparent); color: var(--destructive); }
  .permission-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: .75rem; }
  .permission-group { display: flex; flex-direction: column; gap: .55rem; padding: .65rem .75rem; border: 1px solid var(--border); border-radius: var(--radius-md); }
  .permission-group legend { padding-inline: .25rem; font-weight: 600; }
  .admin-form { display: grid; gap: var(--ui-gap); }
  .admin-panel { display: grid; gap: 1rem; padding: var(--ui-gap); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
  .admin-panel > label { display: grid; gap: .25rem; }
  .admin-panel > .field-hint { margin-block-start: -.6rem; }
  .panel-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem 1rem; }
  .panel-heading h3 { margin: .2rem 0; }
  .panel-heading-actions { display: flex; align-items: center; gap: 8px; }
  .panel-count { min-width: 2rem; height: 2rem; padding-inline: .4rem; display: grid; place-items: center; border-radius: var(--radius-md); background: var(--muted); color: var(--muted-foreground); }
  .admin-panel .admin-members { max-height: none; }
  .admin-panel .admin-members li:last-child { border-bottom: 0; }
  .invite-link { padding: var(--ui-gap); border: 1px solid var(--border); border-radius: var(--radius-md); }

</style>
