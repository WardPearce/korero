<script lang="ts">
  import { Button, Calendar, Checkbox, Collapsible, Input, Textarea, TimeField } from "gridworkdesign";
  import { fromDateToLocal, getLocalTimeZone, toCalendarDate, toCalendarDateTime, toTime, type DateValue, type Time } from "@internationalized/date";
  import { onMount } from "svelte";
  import { Settings2, X } from "@lucide/svelte";
  import IconButton from "./IconButton.svelte";
  import { apiFor, messageFrom, requestError } from "./client";

  let { origin, title, permissions, passwordRequired, onPasswordChange, bannerSupported, bannerImageUrl, onclose }: {
    origin: string;
    title: string;
    permissions: string[];
    passwordRequired: boolean;
    onPasswordChange: (origin: string, required: boolean) => void;
    onclose: () => void;
    bannerSupported: boolean;
    bannerImageUrl: string | null;
  } = $props();

  const tabs = [
    { id: "roles", label: "Roles", permission: "manageRoles" },
    { id: "banner", label: "Banner", permission: "manageSettings" },
    { id: "configuration", label: "Configuration", permission: "manageSettings" },
    { id: "password", label: "Password", permission: "manageSettings" },
    { id: "invitation", label: "Invitations", permission: "manageInvitations" },
  ] as const;
  type Tab = typeof tabs[number]["id"];
  type Roles = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["accounts"]["get"]>>["data"], { accounts: unknown }>;
  type RoleDefinition = Roles["customRoles"][number];
  type Permission = RoleDefinition["permissions"][number];
  const permissionLabels: Record<Permission, string> = {
    join: "Join channels", speak: "Speak in voice", text: "Send messages", createChannels: "Create channels",
    editChannels: "Edit channels", deleteChannels: "Delete channels", move: "Move members", mute: "Mute members",
    kick: "Kick members", ban: "Ban members", manageRoles: "Manage role assignments", manageInvitations: "Manage invitations",
    manageSettings: "Manage server settings", viewAdmin: "View diagnostics and audit log",
  };
  type Configuration = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["configuration"]["get"]>>["data"], { toml: string }>;
  type InvitationList = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["invitations"]["get"]>>["data"], { invitations: unknown }>;
  type Invitation = InvitationList["invitations"][number];
  let tab = $state<Tab>("roles");
  let availableTabs = $derived(tabs.filter(({ id, permission }) => permissions.includes(permission) && (id !== "banner" || bannerSupported)));
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let members = $state.raw<Roles | null>(null);
  let pages = $state<(string | undefined)[]>([undefined]);
  let configuration = $state.raw<Configuration | null>(null);
  let toml = $state("");
  let password = $state("");
  let removePassword = $state(false);
  let invitations = $state.raw<Invitation[] | null>(null);
  let createdInvitation = $state.raw<{ id: string; url: string } | null>(null);
  let editedInvitation = $state.raw<Invitation | null>(null);
  let deletingInvitation = $state("");
  let invitationLimit = $state<number | undefined>(1);
  const defaultExpiry = localInvitationExpiry(Date.now() + 86400000);
  let invitationDay = $state.raw<DateValue | undefined>(toCalendarDate(defaultExpiry));
  let invitationTime = $state.raw<Time | undefined>(toTime(defaultExpiry));
  let expiryOpen = $state(false);
  let invitationExpiry = $derived(invitationDay && invitationTime ? toCalendarDateTime(invitationDay, invitationTime) : undefined);
  let originalExpiry = $derived(editedInvitation?.expiresAt == null ? undefined : localInvitationExpiry(editedInvitation.expiresAt));
  let expiryChanged = $derived(invitationExpiry?.toString() !== originalExpiry?.toString());
  let expiryTitle = $derived(invitationExpiry
    ? `Expires ${invitationExpiry.toDate(getLocalTimeZone()).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
    : invitationDay ? "Set expiration time" : "No expiration");
  let invitationChanged = $derived(editedInvitation && (
    invitationLimit !== (editedInvitation.usesLeft ?? undefined) || expiryChanged
  ));
  let bannerUrl = $state("");
  let roleEditing = $state(false);
  let editedRole = $state("");
  let roleName = $state("");
  let rolePermissions = $state<Permission[]>([]);
  let heading: HTMLHeadingElement;

  onMount(() => {
    heading.focus();
    if (availableTabs[0]) void selectTab(availableTabs[0].id);
  });

  function localInvitationExpiry(timestamp: number) {
    return toCalendarDateTime(fromDateToLocal(new Date(timestamp)));
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
    });
  }

  async function selectTab(next: Tab) {
    if (busy) return;
    tab = next;
    error = "";
    notice = "";
    if (next === "roles" && !members) await loadMembers(pages);
    if (next === "configuration" && !configuration) await loadConfiguration();
    if (next === "banner") bannerUrl = bannerImageUrl ?? "";
    if (next === "invitation") await loadInvitations();
  }

  async function setRole(event: Event, account: Roles["accounts"][number]) {
    const select = event.currentTarget as HTMLSelectElement;
    const role = select.value;
    await run(async () => {
      const response = await apiFor(origin).admin.roles.patch({ accountId: account.id, role });
      if (response.error) throw requestError(response.error);
      if (members) {
        members = { ...members, accounts: members.accounts.map((row) => row.id === account.id ? { ...row, role } : row) };
      }
      notice = `${account.displayName} is now ${role}.`;
    });
    if (error) select.value = account.role;
  }

  function editRole(role?: RoleDefinition) {
    editedRole = role?.name ?? "";
    roleName = editedRole;
    rolePermissions = [...role?.permissions ?? []];
    roleEditing = true;
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
        members = {
          ...members,
          roles: editedRole ? members.roles : [...members.roles, role.name],
          customRoles: editedRole ? members.customRoles.map((item) => item.name === role.name ? role : item) : [...members.customRoles, role],
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

  async function loadConfiguration() {
    await run(async () => {
      const response = await apiFor(origin).admin.configuration.get();
      if (response.error) throw requestError(response.error);
      if (!response.data || !("toml" in response.data)) throw requestError({ value: response.data });
      configuration = response.data;
      toml = response.data.toml;
    });
  }

  function saveConfiguration(event: SubmitEvent) {
    event.preventDefault();
    const current = configuration;
    if (!current) return;
    void run(async () => {
      const response = await apiFor(origin).admin.configuration.patch({ toml, revision: current.revision });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("toml" in response.data)) throw requestError({ value: response.data });
      configuration = response.data;
      toml = response.data.toml;
      notice = "Configuration saved. Restart the server to apply it.";
    });
  }

  function savePassword(event: SubmitEvent) {
    event.preventDefault();
    const requestOrigin = origin;
    void run(async () => {
      const response = await apiFor(requestOrigin).admin.password.patch({ password: removePassword ? null : password });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("passwordRequired" in response.data)) throw requestError({ value: response.data });
      password = "";
      removePassword = false;
      onPasswordChange(requestOrigin, response.data.passwordRequired);
      notice = response.data.passwordRequired ? "Server password saved." : "Server password removed.";
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
    const expiry = localInvitationExpiry(invitation?.expiresAt ?? Date.now() + 86400000);
    invitationDay = invitation?.expiresAt === null ? undefined : toCalendarDate(expiry);
    invitationTime = toTime(expiry);
    expiryOpen = false;
  }

  function saveInvitation(event: SubmitEvent) {
    event.preventDefault();
    const editing = editedInvitation;
    if (editing && !invitationChanged) return;
    void run(async () => {
      const expiresAt = expiryChanged ? invitationExpiry?.toDate(getLocalTimeZone()).getTime() : undefined;
      if (expiryChanged && expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
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
      const response = await api.post({ expiresAt, uses: invitationLimit });
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
        <Button aria-pressed={tab === section.id} disabled={busy} onclick={() => selectTab(section.id)}>
          {section.label}
        </Button>
      {/each}
    </div>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="field-hint" role="status">{notice}</p>{/if}
    {#if busy}<p class="field-hint" role="status">Working…</p>{/if}

    {#if tab === "roles" && permissions.includes("manageRoles")}
      {#if members}
        {#if members.canDefineRoles}
          <section class="role-settings" aria-label="Custom roles">
            <div class="role-heading">
              <h3>Custom roles</h3>
              {#if !roleEditing}<Button disabled={busy} onclick={() => editRole()}>Create role</Button>{/if}
            </div>
            {#if roleEditing}
              <form class="dialog-form" onsubmit={saveRole}>
                <label>Role name<Input required maxlength={80} disabled={busy || Boolean(editedRole)} bind:value={roleName} /></label>
                <fieldset class="role-permissions" disabled={busy}>
                  <legend>Permissions</legend>
                  {#each members.assignablePermissions as permission (permission)}
                    <Checkbox label={permissionLabels[permission]} disabled={busy}
                      bind:checked={() => rolePermissions.includes(permission), (checked) => setRolePermission(permission, checked)} />
                  {/each}
                </fieldset>
                <div class="dialog-actions">
                  <Button type="button" disabled={busy} onclick={() => { roleEditing = false; }}>Cancel</Button>
                  <Button variant="alternate" type="submit" disabled={busy}>{editedRole ? "Save permissions" : "Create role"}</Button>
                </div>
              </form>
            {:else if members.customRoles.length}
              <ul class="admin-members">
                {#each members.customRoles as role (role.name)}
                  <li><span class="truncate">{role.name}</span>
                    <Button aria-label={`Edit permissions for ${role.name}`} disabled={busy} onclick={() => editRole(role)}>Edit</Button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}
        <h3>Accounts</h3>
        <ul class="admin-members">
          {#each members.accounts as account (account.id)}
            <li>
              <span class="shrinkable">
                <strong class="truncate" title={account.displayName}>{account.displayName}</strong>
                <small class="field-hint">{account.id}</small>
              </span>
              {#if account.editable}
                <select aria-label={`Role for ${account.displayName} (${account.id})`} value={account.role}
                  disabled={busy || !members.roles.length} onchange={(event) => setRole(event, account)}>
                  {#if !members.roles.includes(account.role)}<option value={account.role} disabled>{account.role}</option>{/if}
                  {#each members.roles as role (role)}<option value={role}>{role}</option>{/each}
                </select>
              {:else}
                <span>{account.role}</span>
              {/if}
            </li>
          {/each}
        </ul>
        {#if pages.length > 1 || members.next}
          <div class="dialog-actions">
            <Button disabled={busy || pages.length < 2} onclick={() => loadMembers(pages.slice(0, -1))}>Previous</Button>
            <Button disabled={busy || !members.next} onclick={() => loadMembers([...pages, members?.next ?? undefined])}>Next</Button>
          </div>
        {/if}
      {:else if !busy}
        <Button onclick={() => loadMembers(pages)}>Load accounts</Button>
      {/if}
    {:else if tab === "banner" && permissions.includes("manageSettings")}
      <form class="dialog-form" onsubmit={saveBanner}>
        <label>Banner image URL<Input type="url" pattern="https://.+" maxlength={512} placeholder="https://example.com/banner.jpg"
          disabled={busy} bind:value={bannerUrl} /></label>
        <p class="field-hint">Clear the URL to remove the banner.</p>
        <div class="dialog-actions"><Button variant="alternate" type="submit" disabled={busy}>Save banner</Button></div>
      </form>
    {:else if tab === "configuration" && permissions.includes("manageSettings")}
      {#if configuration}
        <form class="dialog-form" onsubmit={saveConfiguration}>
          <p class="field-hint">Restart the server after saving. Environment overrides still take precedence.</p>
          {#if configuration.overrides.length}
            <p class="field-hint">Saving replaces existing in-app overrides for {configuration.overrides.join(" and ")} with values from this file.</p>
          {/if}
          <label>server.toml<Textarea class="config-editor" rows={16} maxlength={65536} spellcheck="false" disabled={busy} bind:value={toml} /></label>
          <div class="dialog-actions">
            <Button type="button" disabled={busy || toml !== configuration.toml} onclick={loadConfiguration}>Reload file</Button>
            {#if toml !== configuration.toml}
              <Button type="button" disabled={busy} onclick={() => { toml = configuration?.toml ?? ""; }}>Discard edits</Button>
            {/if}
            <Button variant="alternate" type="submit" disabled={busy || toml === configuration.toml}>Save configuration</Button>
          </div>
        </form>
      {:else if !busy}
        <Button onclick={loadConfiguration}>Load configuration</Button>
      {/if}
    {:else if tab === "password" && permissions.includes("manageSettings")}
      <form class="dialog-form" onsubmit={savePassword}>
        <p class="field-hint">{passwordRequired ? "A password is required for new sign-ins." : "Set a shared password to require it for new sign-ins."}</p>
        <label>Server password<Input type="password" autocomplete="new-password" maxlength={128} required={!removePassword}
          disabled={busy || removePassword} bind:value={password} /></label>
        {#if passwordRequired}
          <Checkbox label="Remove server password" disabled={busy} bind:checked={removePassword} />
        {/if}
        <div class="dialog-actions"><Button variant="alternate" type="submit" disabled={busy}>Save password</Button></div>
      </form>
    {:else if tab === "invitation" && permissions.includes("manageInvitations")}
      <form class="dialog-form" onsubmit={saveInvitation}>
        <h3>{editedInvitation ? `Edit invitation ${editedInvitation.id.slice(0, 8)}` : "Create invitation"}</h3>
        <label>{editedInvitation ? "Remaining uses" : "Use limit"}
          <Input type="number" min={editedInvitation ? 0 : 1} max="10000" placeholder="Unlimited" disabled={busy} bind:value={invitationLimit} />
        </label>
        <div inert={busy}>
          <Collapsible title={expiryTitle} bind:open={expiryOpen}>
            <div class="expiry-fields" role="group" aria-label="Invitation expiration">
              <Calendar label="Expiration date" bind:value={invitationDay} />
              <TimeField label="Expiration time (local)" bind:value={invitationTime} />
              <Button class="fit-action" type="button" disabled={!invitationDay} onclick={() => { invitationDay = undefined; }}>
                Clear expiration
              </Button>
            </div>
          </Collapsible>
        </div>
        <p class="field-hint">Leave the use limit blank for unlimited uses.</p>
        <div class="dialog-actions">
          {#if editedInvitation}
            <Button type="button" disabled={busy} onclick={() => editInvitation(null)}>Cancel</Button>
          {/if}
          <Button variant="alternate" type="submit"
            disabled={busy || Boolean(invitationDay && !invitationTime) || Boolean(editedInvitation && !invitationChanged)}>
            {editedInvitation ? "Save changes" : "Create invitation"}
          </Button>
        </div>
      </form>
      {#if createdInvitation}
        {@const url = createdInvitation.url}
        <div class="dialog-form">
          <label>Invitation link<Input value={url} readonly /></label>
          <p class="field-hint">Copy this link before creating another invitation or leaving server settings.</p>
          <Button class="fit-action" disabled={busy} onclick={() => copyInvitation(url)}>Copy link</Button>
        </div>
      {/if}
      <h3>Existing invitations</h3>
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
                  <Button disabled={busy} onclick={() => { deletingInvitation = ""; }}>Cancel</Button>
                  <Button variant="alternate" disabled={busy} onclick={() => deleteInvitation(invitation.id)}>Confirm deletion</Button>
                {:else}
                  <Button aria-label={`Edit ${label.toLowerCase()}`} disabled={busy} onclick={() => editInvitation(invitation)}>Edit</Button>
                  <Button aria-label={`Delete ${label.toLowerCase()}`} disabled={busy} onclick={() => { deletingInvitation = invitation.id; }}>Delete</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else if invitations}
        <p class="field-hint">No invitations yet.</p>
      {:else if !busy}
        <Button class="fit-action" onclick={loadInvitations}>Load invitations</Button>
      {/if}
    {/if}
  </div>
</div>

<style>
  .expiry-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    padding-top: 8px;
  }

  .expiry-fields :global(.calendar-root) {
    box-sizing: border-box;
    width: min(100%, 19.5rem);
    padding: 0.5rem;
  }

  .expiry-fields :global(.calendar-grid) { display: block; }

  .expiry-fields :global(.calendar-row) {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }

  .expiry-fields :global(.calendar-weekday),
  .expiry-fields :global(.calendar-cell) { width: auto; }

  .expiry-fields :global(.calendar-day) { min-width: 0; }
</style>
