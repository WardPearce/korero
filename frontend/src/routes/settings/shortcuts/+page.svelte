<script lang="ts">
  import { resolve } from "$app/paths";
  import { Keyboard, X } from "@lucide/svelte";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import ShortcutKey from "#lib/components/fields/ShortcutKey.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { getShortcutSettings } from "#lib/media/shortcut-settings.svelte";
  import { voiceShortcutGroups } from "#lib/media/voice-shortcuts";

  const shortcuts = getShortcutSettings();
  const audio = shortcuts.audio;
  const disabled = $derived(!shortcuts.ready || shortcuts.saving);
  const usesTalkKey = $derived(audio.profile.transmitMode === "pushToTalk" || audio.profile.transmitMode === "toggleToTalk");
</script>

<svelte:head><title>Shortcuts · Korero.chat</title></svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header"><div class="heading-icon"><Keyboard size={19} aria-hidden="true" /></div><h1>Shortcuts</h1></header>
  <div class="workspace settings-content">
    <p class="field-hint">Select a shortcut button, then press a letter, number, function key, or Space. You can include modifiers. Press Escape to cancel.</p>
    {#if shortcuts.error}
      <p class="form-error shortcut-error" role="alert">{shortcuts.error}</p>
    {:else if !shortcuts.ready}
      <p class="field-hint" role="status">Loading shortcuts…</p>
    {/if}
    {#if audio.available}
      <section class="settings-card" aria-labelledby="shortcut-transmission">
        <h2 id="shortcut-transmission">Transmission</h2>
        <div class="shortcut-row">
          <div class="settings-heading">
            <span>Talk shortcut</span>
            {#if !usesTalkKey}
              <p class="field-hint">Select Push-to-talk or Toggle-to-talk in <a class="underline" href={resolve("/settings/audio")}>Audio settings</a> to use this binding.</p>
            {/if}
          </div>
          <ShortcutKey label="Talk shortcut" shortcut={audio.profile.talkShortcut} disabled={disabled || audio.applying}
            onchange={(value) => { void shortcuts.setTalk(value); }} />
        </div>
        <div>
          <Checkbox label="System-wide talk shortcut" disabled={disabled || audio.applying}
            bind:checked={() => audio.profile.globalTalkShortcut, (checked) => { void audio.update("globalTalkShortcut", checked); }} />
          {#if audio.shortcutError || audio.error}
            <p class="form-error" role="alert">{audio.shortcutError || audio.error}</p>
          {:else if usesTalkKey}
            <p class="field-hint">{audio.globalActive ? "The talk shortcut also works while other apps are focused." : "The talk shortcut works while Korero.chat is focused."}</p>
          {/if}
        </div>
        <div class="shortcut-row">
          <span>Whisper shortcut</span>
          <ShortcutKey label="Whisper shortcut" shortcut={shortcuts.whisper.shortcut} {disabled}
            onchange={(value) => { void shortcuts.setWhisper({ shortcut: value }); }} />
        </div>
      </section>
    {/if}
    <section class="settings-card voice-bindings" aria-labelledby="voice-shortcut-heading">
      <div class="settings-heading">
        <h2 id="voice-shortcut-heading">Voice controls</h2>
        <p class="field-hint">These shortcuts work while Korero.chat is focused and you’re in a voice channel.</p>
      </div>
      {#each voiceShortcutGroups as { label, field, actions } (field)}
        <section class="voice-binding-group" aria-labelledby={`shortcut-${field}`}>
          <h3 id={`shortcut-${field}`}>{label}</h3>
          {#each actions as { id, label: actionLabel } (id)}
            {@const shortcut = shortcuts.voice[id]}
            <div class="shortcut-row">
              <span>{actionLabel}</span>
              <div class="shortcut-actions">
                <ShortcutKey label={actionLabel} {shortcut} {disabled} onchange={(value) => { void shortcuts.setVoice(id, value); }} />
                <Button variant="ghost" size="icon" aria-label={`Clear ${actionLabel.toLowerCase()} shortcut`}
                  disabled={disabled || !shortcut} onclick={() => { void shortcuts.setVoice(id); }}>
                  <X aria-hidden="true" />
                </Button>
              </div>
            </div>
          {/each}
        </section>
      {/each}
    </section>
  </div>
</main>

<style>
  .shortcut-row, .shortcut-actions { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .shortcut-row { flex-wrap: wrap; justify-content: space-between; }
  .shortcut-row > .settings-heading { flex: 1 1 16rem; }
  .shortcut-row > span { flex: 1 1 auto; }
  .shortcut-row > :global([data-slot="button"]), .shortcut-actions { margin-inline-start: auto; }
  .shortcut-actions { max-width: 100%; }
  .shortcut-actions :global([data-slot="button"]:first-child) { min-width: min(8rem, calc(100% - var(--control-height) - .5rem)); }
  .shortcut-error { position: sticky; inset-block-start: 0; z-index: 1; }
  .voice-binding-group { display: grid; gap: .35rem; padding-block-start: .75rem; border-block-start: 1px solid var(--border); }
  .voice-binding-group h3 { margin-block-end: .15rem; color: var(--muted-foreground); font-size: var(--type-small); }
</style>
