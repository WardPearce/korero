<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { shortcutFromEvent, talkShortcutLabel, type TalkShortcut } from "#lib/media/talk-shortcut";

  let { label, shortcut, disabled = false, onchange }: {
    label: string;
    shortcut?: TalkShortcut;
    disabled?: boolean;
    onchange: (shortcut: TalkShortcut) => void;
  } = $props();
  let capturing = $state(false);
  const binding = $derived(shortcut ? talkShortcutLabel(shortcut) : "Not set");

  function capture(event: KeyboardEvent) {
    if (!capturing || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      capturing = false;
      return;
    }
    if (event.repeat) return;
    const next = shortcutFromEvent(event);
    if (!next) return;
    capturing = false;
    onchange(next);
  }
</script>

<Button variant="outline" {disabled} aria-label={label + ": " + (capturing ? "Press a shortcut" : binding)}
  data-recording-shortcut={capturing || undefined}
  aria-pressed={capturing} onclick={() => { capturing = !capturing; }} onkeydown={capture}
  onblur={() => { capturing = false; }}>
  {capturing ? "Press a shortcut" : binding}
</Button>
