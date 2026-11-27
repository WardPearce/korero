<script lang="ts">
  import { onMount } from "svelte";
  import { Check, Lock, RotateCcw, X } from "@lucide/svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { apiFor, messageFrom, requestError } from "#lib/connection/client";
  import { channelPermissionGroups, permissionLabels } from "#lib/permissions";

  let { origin, channelId, disabled = false }: {
    origin: string;
    channelId: string;
    disabled?: boolean;
  } = $props();

  type Endpoint = ReturnType<ReturnType<typeof apiFor>["channels"]>["permissions"];
  type Table = Extract<Awaited<ReturnType<Endpoint["get"]>>["data"], { roles: unknown }>;
  type Permission = Table["editable"][number];
  type Choice = boolean | null;

  let table = $state<Table>();
  let loadError = $state("");
  let selectedRole = $state("");
  /** Unsaved choices keyed by `role/permission`. */
  let drafts = $state<Record<string, Choice>>({});

  const role = $derived(table?.roles.find(({ name }) => name === selectedRole));
  const editable = $derived(new Set<string>(table?.editable ?? []));

  // The parent form is keyed by channel, so one load per mount is enough.
  onMount(() => {
    let current = true;
    void (async () => {
      try {
        const loaded = permissionTable(await apiFor(origin).channels({ id: channelId }).permissions.get());
        if (!current) return;
        table = loaded;
        selectedRole = loaded.roles.find(({ name }) => name === "Member")?.name ?? loaded.roles[0]?.name ?? "";
      } catch (error) {
        if (current) loadError = messageFrom(error);
      }
    })();
    return () => { current = false; };
  });

  function permissionTable(response: { data: unknown; error: unknown }) {
    if (response.error) throw requestError(response.error);
    if (!response.data || typeof response.data !== "object" || !("roles" in response.data)) throw requestError({ value: response.data });
    return response.data as Table;
  }

  function choice(roleName: string, permission: Permission): Choice {
    const key = `${roleName}/${permission}`;
    if (key in drafts) return drafts[key]!;
    return table?.roles.find(({ name }) => name === roleName)?.permissions[permission].allow ?? null;
  }

  function choose(roleName: string, permission: Permission, value: Choice) {
    const saved = table?.roles.find(({ name }) => name === roleName)?.permissions[permission].allow ?? null;
    const key = `${roleName}/${permission}`;
    if (saved === value) delete drafts[key];
    else drafts[key] = value;
  }

  const allPermissions = channelPermissionGroups.flatMap(({ permissions }) => permissions);
  const overrideCount = (roleName: string) => allPermissions.filter((permission) => choice(roleName, permission) !== null).length;
  const hasUnsaved = (roleName: string) => Object.keys(drafts).some((key) => key.startsWith(`${roleName}/`));
  const resettable = $derived(role ? allPermissions.some((permission) =>
    editable.has(permission) && choice(role.name, permission) !== null) : false);

  function resetRole() {
    if (!role) return;
    for (const permission of allPermissions) if (editable.has(permission)) choose(role.name, permission, null);
  }

  /** Matching the role's usual grant stores no override, so later server or parent changes still apply. */
  function setEnabled(roleName: string, permission: Permission, enabled: boolean, inherited: boolean) {
    choose(roleName, permission, enabled === inherited ? null : enabled);
  }

  /** Overrides that differ from what the server last reported. */
  export function changes() {
    return Object.entries(drafts).map(([key, allow]) => {
      const separator = key.lastIndexOf("/");
      return { role: key.slice(0, separator), permission: key.slice(separator + 1) as Permission, allow };
    });
  }

  /** Sends unsaved overrides and refreshes the table from the server's reply. */
  export async function save() {
    const pendingChanges = changes();
    if (!pendingChanges.length) return;
    const response = await apiFor(origin).channels({ id: channelId }).permissions.patch({ changes: pendingChanges });
    table = permissionTable(response);
    drafts = {};
  }
</script>

<fieldset class="channel-permissions">
  <legend class="sr-only">Role permissions</legend>
  <p class="field-hint">
    Choose what each role can do in this channel. Subchannels follow these choices unless they set their own.
  </p>
  {#if loadError}
    <p class="form-error" role="alert">{loadError}</p>
  {:else if !table}
    <p class="field-hint">Loading role permissions…</p>
  {:else if !table.roles.length}
    <p class="field-hint">There are no roles below yours to configure.</p>
  {:else}
    <div class="role-picker" role="group" aria-label="Role">
      {#each table.roles as entry (entry.name)}
        {@const count = overrideCount(entry.name)}
        <Button type="button" size="sm" variant="outline" aria-pressed={entry.name === selectedRole}
          onclick={() => { selectedRole = entry.name; }}>
          {entry.name}
          {#if count}<span class="override-count" title="{count} changed from the role’s defaults">{count}</span>{/if}
          {#if hasUnsaved(entry.name)}<span class="unsaved-dot" title="Unsaved changes"><span class="sr-only">Unsaved changes</span></span>{/if}
        </Button>
      {/each}
    </div>

    {#if role}
      {@const roleName = role.name}
      <div class="permission-panel">
        <div class="panel-header">
          <span class="text-sm font-medium">{roleName}</span>
          <Button type="button" size="sm" variant="ghost" disabled={disabled || !resettable} onclick={resetRole}>
            <RotateCcw size={14} aria-hidden="true" />Reset to defaults
          </Button>
        </div>
        {#each channelPermissionGroups as group (group.label)}
          <section class="permission-group" aria-label={group.label}>
            <h3 class="group-label">{group.label}</h3>
            {#each group.permissions as permission (permission)}
              {@const inherited = role.permissions[permission].inherited}
              {@const enabled = choice(roleName, permission) ?? inherited}
              {@const locked = disabled || !editable.has(permission)}
              {@const name = `channel-permission-${roleName}-${permission}`}
              <div class={["permission-row", { changed: `${roleName}/${permission}` in drafts }]}>
                <div class="min-w-0">
                  <span id="{name}-label" class="block text-sm">{permissionLabels[permission]}</span>
                  {#if !editable.has(permission)}
                    <span class="permission-note"><Lock size={12} aria-hidden="true" />You need this permission to change it</span>
                  {/if}
                </div>
                <div class="segments" role="radiogroup" aria-labelledby="{name}-label">
                  {#each [{ value: true, label: "Enabled", icon: Check }, { value: false, label: "Disabled", icon: X }] as option (option.label)}
                    <label class="segment" data-option={option.value ? "allow" : "deny"}>
                      <input class="sr-only" type="radio" {name} disabled={locked} checked={enabled === option.value}
                        onchange={() => setEnabled(roleName, permission, option.value, inherited)} />
                      <option.icon size={14} aria-hidden="true" />{option.label}
                    </label>
                  {/each}
                </div>
              </div>
            {/each}
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</fieldset>

<style>
  .channel-permissions { position: relative; display: grid; gap: 10px; min-width: 0; border: 0; margin: 0; padding: 0; }
  .role-picker { display: flex; flex-wrap: wrap; gap: 6px; }
  .override-count {
    min-width: 1.25rem; padding: 0 5px; border-radius: 999px; background: var(--primary); color: var(--primary-foreground);
    font-size: var(--type-caption); line-height: 1.25rem; text-align: center;
  }
  .unsaved-dot { position: relative; width: 7px; height: 7px; border-radius: 999px; background: var(--warning); }
  .permission-panel { display: grid; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 6px 6px 12px; border-bottom: 1px solid var(--border);
  }
  .permission-group + .permission-group { border-top: 1px solid var(--border); }
  .group-label {
    margin: 0; padding: 10px 12px 2px; color: var(--muted-foreground);
    font-size: var(--type-caption); font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  }
  .permission-row {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px;
    padding: 8px 12px; border-inline-start: 2px solid transparent;
  }
  .permission-row.changed { border-inline-start-color: var(--warning); }
  .permission-note {
    display: flex; align-items: center; gap: 4px; color: var(--muted-foreground); font-size: var(--type-caption);
  }
  .segments {
    display: grid; grid-template-columns: repeat(2, 6rem); flex-shrink: 0;
    border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden;
  }
  /* Doubled selector outranks the form's global label grid; position keeps hidden radios inside the pane. */
  .segments .segment {
    position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 2rem; padding: 0 6px;
    color: var(--muted-foreground); font-size: var(--type-small); cursor: pointer; user-select: none;
  }
  .segment + .segment { border-inline-start: 1px solid var(--border); }
  .segment:hover:not(:has(:disabled)) { background: var(--control-hover); color: var(--foreground); }
  .segment:has(:focus-visible) { outline: 2px solid var(--ring, var(--primary)); outline-offset: -2px; }
  .segment:has(:disabled) { cursor: not-allowed; opacity: .55; }
  .segment:has(:checked) { background: var(--control-selected); color: var(--foreground); font-weight: 500; }
  .segment[data-option="allow"]:has(:checked) {
    background: color-mix(in oklab, var(--success) 22%, transparent); color: var(--success);
  }
  .segment[data-option="deny"]:has(:checked) {
    background: color-mix(in oklab, var(--destructive) 22%, transparent); color: var(--destructive);
  }
</style>
