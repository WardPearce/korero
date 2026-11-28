<script lang="ts">
  import { CalendarClock } from "@lucide/svelte";
  import { getLocalTimeZone, today, type DateValue } from "@internationalized/date";
  import dayjs from "dayjs";
  import { Calendar } from "#lib/components/ui/calendar/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { formatTimestamp, timestampStyles, timestampToken, type TimestampStyle } from "#lib/chat/chat-timestamps";

  let { disabled = false, triggerClass, oninsert }: {
    disabled?: boolean;
    triggerClass?: string;
    /** Receives the `<t:unix:style>` token to insert into the draft. */
    oninsert: (token: string) => void;
  } = $props();

  const label = "Insert timestamp";
  let open = $state(false);
  let date = $state<DateValue | undefined>(today(getLocalTimeZone()));
  let time = $state(dayjs().format("HH:mm"));
  let now = $state(Date.now());

  const seconds = $derived.by(() => {
    if (!date) return undefined;
    const [hour, minute] = time.split(":").map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
    // Month in DateValue is 1-based; dayjs is 0-based. Built in the viewer's local zone.
    return dayjs().year(date.year).month(date.month - 1).date(date.day).hour(hour).minute(minute).second(0).unix();
  });

  $effect(() => {
    if (!open) return;
    const timer = setInterval(() => { now = Date.now(); }, 15_000);
    return () => clearInterval(timer);
  });

  function setNow() {
    date = today(getLocalTimeZone());
    time = dayjs().format("HH:mm");
    now = Date.now();
  }

  function insert(style: TimestampStyle) {
    if (seconds === undefined) return;
    oninsert(timestampToken(seconds, style));
    open = false;
  }
</script>

<Popover.Root bind:open onOpenChange={(next) => { if (next) now = Date.now(); }}>
  <Popover.Trigger type="button" aria-label={label} title={label} {disabled} class={triggerClass}>
    <CalendarClock size={17} />
  </Popover.Trigger>
  <Popover.Content side="top" align="end" collisionPadding={8}
    class="w-auto max-w-[calc(100vw-16px)] max-h-(--bits-popover-content-available-height) overflow-y-auto p-2" aria-label="Timestamp picker">
    <div class="picker-body">
      <div class="when">
        <Calendar type="single" bind:value={date} captionLayout="dropdown" calendarLabel="Date" class="p-0" />
        <div class="time-row">
          <Input type="time" step={60} bind:value={time} aria-label="Time" />
          <Button variant="outline" onclick={setNow}>Now</Button>
        </div>
      </div>
      <div class="styles" role="group" aria-label="Insert timestamp">
        {#each timestampStyles as entry (entry.style)}
          <button type="button" class="style-option" title={entry.label} aria-label={entry.label}
            disabled={seconds === undefined} onclick={() => insert(entry.style)}>
            {seconds === undefined ? "—" : formatTimestamp(seconds, entry.style, now)}
          </button>
        {/each}
      </div>
    </div>
  </Popover.Content>
</Popover.Root>

<style>
  .picker-body { display: flex; flex-wrap: wrap; gap: .75rem; }
  .when { display: grid; gap: .5rem; align-content: start; }
  .time-row { display: flex; gap: .5rem; }
  .styles { display: flex; flex-direction: column; gap: .15rem; flex: 1; padding-inline-start: .75rem; border-inline-start: 1px solid var(--border); }
  .style-option { padding: .4rem .55rem; border-radius: var(--radius-sm); text-align: start; white-space: nowrap; }
  .style-option:hover:not(:disabled), .style-option:focus-visible { background: color-mix(in srgb, var(--primary) 16%, transparent); outline: none; }
  .style-option:disabled { opacity: .5; }
  @media (max-width: 40rem) {
    .styles { padding-inline-start: 0; border-inline-start: 0; padding-block-start: .5rem; border-block-start: 1px solid var(--border); }
  }
</style>
