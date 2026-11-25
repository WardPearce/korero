<script lang="ts">
  import { onMount } from "svelte";
  import { Settings2 } from "lucide-svelte";
  import Modal from "./Modal.svelte";
  import { apiFor, messageFrom, requestError } from "./client";

  let { open = $bindable(false), origin, title, permissions, passwordRequired, onPasswordChange, bannerSupported, bannerImageUrl }: {
    open: boolean;
    origin: string;
    title: string;
    permissions: string[];
    passwordRequired: boolean;
    onPasswordChange: (required: boolean) => void;
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
  let invitation = $state("");
  let invitationLimit = $state<number | undefined>(1);
  let invitationExpiry = $state(defaultInvitationExpiry());
  let bannerUrl = $state("");
  let roleEditing = $state(false);
  let editedRole = $state("");
  let roleName = $state("");
  let rolePermissions = $state<Permission[]>([]);

  onMount(() => {
    if (availableTabs[0]) void selectTab(availableTabs[0].id);
  });

  function defaultInvitationExpiry() {
    const tomorrow = new Date(Date.now() + 86400000);
    return new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
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
    void run(async () => {
      const response = await apiFor(origin).admin.password.patch({ password: removePassword ? null : password });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("passwordRequired" in response.data)) throw requestError({ value: response.data });
      password = "";
      removePassword = false;
      onPasswordChange(response.data.passwordRequired);
      notice = response.data.passwordRequired ? "Server password saved." : "Server password removed.";
    });
  }

  function createInvitation(event: SubmitEvent) {
    event.preventDefault();
    void run(async () => {
      const expiresAt = invitationExpiry ? new Date(invitationExpiry).getTime() : undefined;
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
        throw new Error("Choose a future expiration date.");
      }
      const response = await apiFor(origin).admin.invitations.post({ expiresAt, uses: invitationLimit });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("token" in response.data)) throw requestError({ value: response.data });
      invitation = response.data.token;
    });
  }
</script>

<Modal bind:open title="Server administration" description={title} dismissible={!busy}>
  {#snippet icon()}<Settings2 size={21} />{/snippet}
  <div class="server-admin">
    <div class="admin-tabs" aria-label="Administration sections">
      {#each availableTabs as section (section.id)}
        <button class="secondary-button" aria-pressed={tab === section.id} disabled={busy} onclick={() => selectTab(section.id)}>
          {section.label}
        </button>
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
              {#if !roleEditing}<button class="secondary-button" disabled={busy} onclick={() => editRole()}>Create role</button>{/if}
            </div>
            {#if roleEditing}
              <form class="dialog-form" onsubmit={saveRole}>
                <label>Role name<input required maxlength="80" disabled={busy || Boolean(editedRole)} bind:value={roleName} /></label>
                <fieldset class="role-permissions" disabled={busy}>
                  <legend>Permissions</legend>
                  {#each members.assignablePermissions as permission (permission)}
                    <label class="checkbox-label">
                      <input type="checkbox" value={permission} bind:group={rolePermissions} /> {permissionLabels[permission]}
                    </label>
                  {/each}
                </fieldset>
                <div class="dialog-actions">
                  <button class="secondary-button" type="button" disabled={busy} onclick={() => { roleEditing = false; }}>Cancel</button>
                  <button class="primary-button" type="submit" disabled={busy}>{editedRole ? "Save permissions" : "Create role"}</button>
                </div>
              </form>
            {:else if members.customRoles.length}
              <ul class="admin-members">
                {#each members.customRoles as role (role.name)}
                  <li><span class="truncate">{role.name}</span>
                    <button class="secondary-button" aria-label={`Edit permissions for ${role.name}`} disabled={busy} onclick={() => editRole(role)}>Edit</button>
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
              <span class="min-w-0">
                <strong class="block truncate" title={account.displayName}>{account.displayName}</strong>
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
            <button class="secondary-button" disabled={busy || pages.length < 2} onclick={() => loadMembers(pages.slice(0, -1))}>Previous</button>
            <button class="secondary-button" disabled={busy || !members.next} onclick={() => loadMembers([...pages, members?.next ?? undefined])}>Next</button>
          </div>
        {/if}
      {:else if !busy}
        <button class="secondary-button" onclick={() => loadMembers(pages)}>Load accounts</button>
      {/if}
    {:else if tab === "banner" && permissions.includes("manageSettings")}
      <form class="dialog-form" onsubmit={saveBanner}>
        <label>Banner image URL<input type="url" pattern="https://.+" maxlength="512" placeholder="https://example.com/banner.jpg"
          disabled={busy} bind:value={bannerUrl} /></label>
        <p class="field-hint">Clear the URL to remove the banner.</p>
        <div class="dialog-actions"><button class="primary-button" type="submit" disabled={busy}>Save banner</button></div>
      </form>
    {:else if tab === "configuration" && permissions.includes("manageSettings")}
      {#if configuration}
        <form class="dialog-form" onsubmit={saveConfiguration}>
          <p class="field-hint">Restart the server after saving. Environment overrides still take precedence.</p>
          {#if configuration.overrides.length}
            <p class="field-hint">Saving replaces existing in-app overrides for {configuration.overrides.join(" and ")} with values from this file.</p>
          {/if}
          <label>server.toml<textarea class="config-editor" rows="16" maxlength="65536" spellcheck="false" disabled={busy} bind:value={toml}></textarea></label>
          <div class="dialog-actions">
            <button type="button" class="secondary-button" disabled={busy || toml !== configuration.toml} onclick={loadConfiguration}>Reload file</button>
            {#if toml !== configuration.toml}
              <button type="button" class="secondary-button" disabled={busy} onclick={() => { toml = configuration?.toml ?? ""; }}>Discard edits</button>
            {/if}
            <button class="primary-button" type="submit" disabled={busy || toml === configuration.toml}>Save configuration</button>
          </div>
        </form>
      {:else if !busy}
        <button class="secondary-button" onclick={loadConfiguration}>Load configuration</button>
      {/if}
    {:else if tab === "password" && permissions.includes("manageSettings")}
      <form class="dialog-form" onsubmit={savePassword}>
        <p class="field-hint">{passwordRequired ? "A password is required for new sign-ins." : "Set a shared password to require it for new sign-ins."}</p>
        <label>Server password<input type="password" autocomplete="new-password" maxlength="128" required={!removePassword}
          disabled={busy || removePassword} bind:value={password} /></label>
        {#if passwordRequired}
          <label class="checkbox-label"><input type="checkbox" disabled={busy} bind:checked={removePassword} /> Remove server password</label>
        {/if}
        <div class="dialog-actions"><button class="primary-button" type="submit" disabled={busy}>Save password</button></div>
      </form>
    {:else if tab === "invitation" && permissions.includes("manageInvitations")}
      <form class="dialog-form" onsubmit={createInvitation}>
        <label>User limit<input type="number" min="1" max="10000" placeholder="Unlimited" disabled={busy} bind:value={invitationLimit} /></label>
        <label>Expiration date and time<input type="datetime-local" disabled={busy} bind:value={invitationExpiry} /></label>
        <p class="field-hint">Times are local. Leave a field blank for unlimited uses or no expiration.</p>
        {#if invitation}<label>Invitation code<input value={invitation} readonly /></label>{/if}
        <div class="dialog-actions"><button class="primary-button" type="submit" disabled={busy}>Create invitation</button></div>
      </form>
    {/if}
  </div>
</Modal>
