<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import { apiFor, messageFrom, requestError } from "#lib/connection/client";

  let { origin }: { origin: string } = $props();
  type AuditPage = Extract<Awaited<ReturnType<ReturnType<typeof apiFor>["admin"]["audit"]["get"]>>["data"], { events: unknown }>;
  const categories = [
    { value: "all", label: "All events" }, { value: "account", label: "Accounts" },
    { value: "connection", label: "Connections" }, { value: "voice", label: "Voice activity" },
    { value: "channel", label: "Channels" }, { value: "role", label: "Roles" },
    { value: "moderation", label: "Moderation" }, { value: "invitation", label: "Invitations" },
    { value: "server", label: "Server settings" }, { value: "message", label: "Messages" },
  ];
  const actionLabels: Record<string, string> = {
    "account.registered": "Registered",
    "account.profile_changed": "Changed display name",
    "account.muted": "Muted member",
    "account.unmuted": "Unmuted member",
    "account.deafened": "Deafened member",
    "account.undeafened": "Undeafened member",
    "connection.opened": "Connected to server",
    "connection.closed": "Disconnected from server",
    "voice.joined": "Joined voice channel",
    "voice.left": "Left voice channel",
    "channel.moved": "Moved member to a channel",
    "moderation.kick": "Kicked member",
    "moderation.ban": "Banned member",
    "moderation.unban": "Unbanned member",
    "server.motd_changed": "Updated message of the day",
    "server.default_role_changed": "Changed default role",
    "server.voice_quality_changed": "Changed default voice bitrate",
  };
  let audit = $state.raw<AuditPage | null>(null);
  let pages = $state<(number | undefined)[]>([undefined]);
  let category = $state("all");
  let actorId = $state("");
  let filters = $state.raw({ category: "all", actorId: "" });
  let busy = $state(false);
  let error = $state("");
  const formatTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

  onMount(() => { void load([undefined], filters); });

  async function load(nextPages: (number | undefined)[], nextFilters = filters) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const response = await apiFor(origin).admin.audit.get({ query: {
        before: nextPages.at(-1), prefix: nextFilters.category === "all" ? undefined : nextFilters.category,
        actorId: nextFilters.actorId || undefined,
      } });
      if (response.error) throw requestError(response.error);
      if (!response.data || !("events" in response.data)) throw requestError({ value: response.data });
      audit = response.data;
      pages = nextPages;
      filters = nextFilters;
    } catch (reason) {
      error = messageFrom(reason);
    } finally {
      busy = false;
    }
  }

  function words(value: string) {
    const label = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._]/g, " ");
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function detail(key: string, value: NonNullable<AuditPage["events"][number]["details"]>[string]) {
    if (key === "bitrate" || key === "previousBitrate") return typeof value === "number" ? `${value / 1000} kbps` : "Server configuration";
    if (value === null) return "—";
    if (Array.isArray(value)) return value.map(words).join(", ") || "None";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
  }
</script>

<section aria-label="Audit log" class="audit-log" aria-busy={busy}>
  <form class="audit-filters" onsubmit={(event) => {
    event.preventDefault();
    void load([undefined], { category, actorId: actorId.trim() });
  }}>
    <SelectField label="Event type" options={categories} bind:value={category} disabled={busy} />
    <label>Actor account ID
      <Input bind:value={actorId} disabled={busy} maxlength={36} pattern="[a-f0-9]{8}[-][a-f0-9]{4}[-][a-f0-9]{4}[-][a-f0-9]{4}[-][a-f0-9]{12}" />
    </label>
    <Button variant="outline" type="submit" disabled={busy}>Apply filters</Button>
    <Button variant="outline" type="button" disabled={busy} onclick={() => load([undefined])}>Refresh</Button>
  </form>
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  {#if busy}<p class="field-hint" role="status">Loading audit events…</p>{/if}
  {#if audit?.events.length}
    <ol class="audit-events">
      {#each audit.events as event (event.id)}
        <li>
          <div class="audit-heading">
            <strong>{actionLabels[event.action] ?? words(event.action)}</strong>
            <time class="field-hint" datetime={new Date(event.createdAt).toISOString()}>{formatTime.format(event.createdAt)}</time>
          </div>
          <p>
            {event.actorName ?? event.actorId ?? "Server"}
            {#if event.targetId && event.targetId !== event.actorId}
              <span class="field-hint"> · {event.targetName ?? event.details?.channelName ?? event.targetId}</span>
            {/if}
          </p>
          {#if event.actorId || event.targetId || event.details}
            <details>
              <summary>Event details</summary>
              <dl>
                {#if event.actorId}<dt>Actor account ID</dt><dd>{event.actorId}</dd>{/if}
                {#if event.targetId && event.targetId !== event.actorId}<dt>Target</dt><dd>{event.targetId}</dd>{/if}
                {#each Object.entries(event.details ?? {}) as [key, value] (key)}
                  <dt>{words(key)}</dt><dd>{detail(key, value)}</dd>
                {/each}
              </dl>
            </details>
          {/if}
        </li>
      {/each}
    </ol>
  {:else if audit && !busy}
    <p class="field-hint">No matching audit events.</p>
  {/if}
  {#if pages.length > 1 || audit?.next}
    <div class="dialog-actions">
      <Button variant="outline" disabled={busy || pages.length < 2} onclick={() => load(pages.slice(0, -1))}>Newer</Button>
      <Button variant="outline" disabled={busy || !audit?.next} onclick={() => load([...pages, audit?.next ?? undefined])}>Older</Button>
    </div>
  {/if}
</section>

<style>
  .audit-log, .audit-filters { display: grid; gap: .75rem; }
  .audit-filters { grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); align-items: end; }
  .audit-events { display: grid; gap: .5rem; padding: 0; list-style: none; }
  .audit-events li { padding: .75rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); overflow-wrap: anywhere; }
  .audit-heading { display: flex; justify-content: space-between; align-items: baseline; gap: .25rem 1rem; flex-wrap: wrap; }
  details { margin-top: .25rem; color: var(--muted-foreground); }
  summary { width: fit-content; cursor: pointer; }
  dl { display: grid; grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr); gap: .25rem .75rem; margin: .5rem 0 0; }
  dd { margin: 0; }
</style>
