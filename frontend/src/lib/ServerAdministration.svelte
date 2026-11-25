<script lang="ts">
  import { onMount } from "svelte";
  import { Settings2 } from "lucide-svelte";
  import Modal from "./Modal.svelte";
  import { apiFor, messageFrom, requestError } from "./client";

  let { open = $bindable(false), origin, title, permissions, passwordRequired, onPasswordChange }: {
    open: boolean;
    origin: string;
    title: string;
    permissions: string[];
    passwordRequired: boolean;
    onPasswordChange: (required: boolean) => void;
  } = $props();

  const tabs = [
    { id: "roles", label: "Roles", permission: "manageRoles" },
    { id: "configuration", label: "Configuration", permission: "manageSettings" },
    { id: "password", label: "Password", permission: "manageSettings" },
    { id: "invitation", label: "Invitations", permission: "manageInvitations" },
  ] as const;
  type Tab = typeof tabs[number]["id"];
  type Roles = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["accounts"]["get"]>>["data"], { accounts: unknown }>;
  type Role = Roles["roles"][number];
  type Configuration = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["configuration"]["get"]>>["data"], { toml: string }>;
  let tab = $state<Tab>("roles");
  let availableTabs = $derived(tabs.filter(({ permission }) => permissions.includes(permission)));
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

  onMount(() => {
    if (availableTabs[0]) void selectTab(availableTabs[0].id);
  });

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
  }

  async function setRole(event: Event, account: Roles["accounts"][number]) {
    const select = event.currentTarget as HTMLSelectElement;
    const role = select.value as Role;
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

  function createInvitation() {
    void run(async () => {
      const response = await apiFor(origin).admin.invitations.post({ expiresInSeconds: 86400, uses: 1 });
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
        <ul class="admin-members">
          {#each members.accounts as account (account.id)}
            <li>
              <span class="min-w-0">
                <strong class="block truncate" title={account.displayName}>{account.displayName}</strong>
                <small class="field-hint">{account.id}</small>
              </span>
              {#if account.editable}
                <select aria-label={`Role for ${account.displayName} (${account.id})`} value={account.role}
                  disabled={busy} onchange={(event) => setRole(event, account)}>
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
      <div class="dialog-form">
        <p class="field-hint">Create a one-use invitation that expires in 24 hours.</p>
        {#if invitation}<label>Invitation code<input value={invitation} readonly /></label>{/if}
        <div class="dialog-actions"><button class="primary-button" disabled={busy} onclick={createInvitation}>Create invitation</button></div>
      </div>
    {/if}
  </div>
</Modal>
