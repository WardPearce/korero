<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { shortcutFromEvent, talkShortcutLabel, type TalkShortcut } from "#lib/media/talk-shortcut";

  let { label = "Talk shortcut", shortcut, disabled = false, onchange }: {
    label?: string;
    shortcut: TalkShortcut;
    disabled?: boolean;
    onchange: (shortcut: TalkShortcut) => void;
  } = $props();
  let capturing = $state(false);

  function capture(event: KeyboardEvent) {
    if (!capturing || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") capturing = false;
    if (event.repeat) return;
    const next = shortcutFromEvent(event);
    if (!next) return;
    capturing = false;
    onchange(next);
  }
</script>

<Button variant="outline" {disabled} aria-label={label + ": " + talkShortcutLabel(shortcut)}
  aria-pressed={capturing} onclick={() => { capturing = !capturing; }} onkeydown={capture}
  onblur={() => { capturing = false; }}>
  {capturing ? "Press a shortcut" : talkShortcutLabel(shortcut)}
</Button>
