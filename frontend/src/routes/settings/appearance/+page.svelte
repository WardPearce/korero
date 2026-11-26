<script lang="ts">
  import { Check, Download, MessageCircle, Palette, Pencil, Plus, Send, Upload } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import Checkbox from "#lib/components/LabeledCheckbox.svelte";
  import Modal from "#lib/Modal.svelte";
  import {
    applyTheme, builtInThemes, colorFields, contrast, defaultTheme, parseTheme, playfulThemes, readAppearance,
    saveAppearance, swatchColors, themeFor, themeStyle, type Appearance, type SavedTheme, type Theme,
  } from "#lib/theme";

  const sampleStatuses = [
    ["success", "Success"], ["danger", "Danger"], ["warning", "Warning"], ["info", "Info"],
  ] as const;
  const themeFilters = [
    ["all", "All themes"], ["dark", "Dark themes"], ["light", "Light themes"], ["playful", "Playful"],
  ] as const;

  let appearance = $state.raw(readAppearance());
  let active = $derived(themeFor(appearance));
  let activeIsCustom = $derived(appearance.custom.some(({ id }) => id === active.id));
  let filter = $state<(typeof themeFilters)[number][0]>("all");
  let visibleThemes = $derived.by(() => {
    if (filter === "all") return builtInThemes;
    if (filter === "playful") return playfulThemes;
    return builtInThemes.filter(({ scheme }) => scheme === filter);
  });
  let draft = $state<Theme>();
  let editingId = $state<string>();
  let previewInApp = $state(false);
  let confirmDelete = $state(false);
  let status = $state("");
  let error = $state("");
  let fileInput: HTMLInputElement;
  let createButton = $state<HTMLButtonElement | null>(null);

  let readability = $derived.by(() => {
    if (!draft) return 0;
    const { text, mutedText, background, panel, surface } = draft.colors;
    return Math.min(...[text, mutedText].flatMap((color) => [background, panel, surface].map((base) => contrast(color, base))));
  });

  $effect(() => {
    if (draft && previewInApp) applyTheme(draft);
  });

  onDestroy(() => {
    if (previewInApp) applyTheme(themeFor(appearance));
  });

  function updateAppearance(next: Appearance, message: string) {
    appearance = next;
    status = saveAppearance(next) ? message : "This device blocked storage. Changes apply until you close or reload the app.";
    error = "";
  }

  function select(theme: SavedTheme) {
    previewInApp = false;
    updateAppearance({ ...appearance, active: theme.id }, theme.name + " applied.");
  }

  function startEditor(theme: Theme, id?: string) {
    draft = { ...theme, colors: { ...theme.colors } };
    editingId = id;
    status = "";
    error = "";
  }

  function createTheme() {
    startEditor({ ...active, name: "My " + active.name.slice(0, 37) });
  }

  function togglePreview(checked: boolean) {
    previewInApp = checked;
    if (!checked) applyTheme(active);
  }

  async function closeEditor() {
    togglePreview(false);
    draft = undefined;
    editingId = undefined;
    confirmDelete = false;
    error = "";
    await tick();
    createButton?.focus();
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const theme = parseTheme(draft);
    if (!theme) {
      error = "Enter a theme name and valid appearance values.";
      return;
    }
    const id = editingId ?? "custom-" + crypto.randomUUID();
    const saved = { ...theme, id };
    const custom = editingId
      ? appearance.custom.map((entry) => entry.id === id ? saved : entry)
      : [...appearance.custom, saved];
    updateAppearance({ active: id, custom }, theme.name + " saved and applied.");
    void closeEditor();
  }

  function deleteTheme() {
    if (!editingId) return;
    const custom = appearance.custom.filter(({ id }) => id !== editingId);
    updateAppearance({
      active: appearance.active === editingId ? defaultTheme.id : appearance.active,
      custom,
    }, "Theme deleted.");
    void closeEditor();
  }

  async function importTheme(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      if (file.size > 16_384) throw new Error();
      const data = JSON.parse(await file.text());
      const theme = data?.version === 1 ? parseTheme(data.theme) : undefined;
      if (!theme) throw new Error();
      if (!draft) startEditor(theme);
    } catch {
      error = "Choose a valid VNX.chat theme JSON file.";
    }
  }

  function exportTheme() {
    const theme = parseTheme(active);
    if (!theme) return;
    const link = document.createElement("a");
    link.href = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ version: 1, theme }, null, 2));
    link.download = (theme.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme") + ".json";
    link.click();
  }
</script>

<svelte:head><title>Appearance · VNX.chat</title></svelte:head>

{#snippet themeTile(theme: SavedTheme)}
  <button class="theme-tile" type="button" aria-pressed={active.id === theme.id} onclick={() => select(theme)}>
    <span class="swatch-card" style={themeStyle(theme)} aria-hidden="true">
      <span class="swatches">
        {#each swatchColors as color (color)}
          <span style:--swatch={theme.colors[color]}></span>
        {/each}
      </span>
      {#if active.id === theme.id}<span class="selected-mark"><Check size={13} strokeWidth={3} /></span>{/if}
    </span>
    <span class="theme-name">{theme.name}</span>
  </button>
{/snippet}

<main class="room-pane settings-pane">
  <header class="workspace-header">
    <div class="heading-icon"><Palette size={19} aria-hidden="true" /></div>
    <h1>Appearance</h1>
  </header>
  <div class="workspace">
    <section class="settings-card appearance-card" aria-labelledby="themes-heading">
      <div class="appearance-heading">
        <div>
          <h2 id="themes-heading">Themes</h2>
          <p class="field-hint" role="status">{status || "Using " + active.name}</p>
        </div>
        <div class="theme-actions">
          <Button variant="outline" disabled={!!draft} onclick={() => fileInput.click()}><Upload /> Import</Button>
          <Button bind:ref={createButton} disabled={!!draft} onclick={createTheme}><Plus /> Create theme</Button>
          <input type="file" accept=".json,application/json" hidden bind:this={fileInput} onchange={importTheme} />
        </div>
      </div>
      {#if error && !draft}<p class="form-error" role="alert">{error}</p>{/if}
      <div class="theme-actions">
        {#if activeIsCustom}
          <Button variant="outline" disabled={!!draft} onclick={() => startEditor(active, active.id)}><Pencil /> Edit theme</Button>
        {:else}
          <Button variant="outline" disabled={!!draft} onclick={createTheme}><Pencil /> Customize selected theme</Button>
        {/if}
        <Button variant="ghost" onclick={exportTheme}><Download /> Export selected theme</Button>
      </div>
      {#if appearance.custom.length}
        <div class="custom-themes">
          <h3 id="custom-heading">My themes</h3>
          <div class="theme-grid" role="group" aria-labelledby="custom-heading">
            {#each appearance.custom as theme (theme.id)}
              {@render themeTile(theme)}
            {/each}
          </div>
        </div>
      {/if}
      <div class="theme-actions theme-filters" role="group" aria-label="Filter built-in themes">
        {#each themeFilters as [value, label] (value)}
          <Button variant={filter === value ? "secondary" : "outline"} aria-pressed={filter === value}
            aria-controls="built-in-themes" onclick={() => { filter = value; }}>{label}</Button>
        {/each}
      </div>
      <div id="built-in-themes" class="theme-grid" role="group" aria-label="Built-in themes">
        {#each visibleThemes as theme (theme.id)}
          {@render themeTile(theme)}
        {/each}
      </div>
    </section>

    {#if draft}
      <section class="settings-card appearance-card" aria-labelledby="editor-heading">
        <h2 id="editor-heading" tabindex="-1" {@attach (element) => element.focus()}>{editingId ? "Edit theme" : "Create a custom theme"}</h2>
        <form class="theme-editor" onsubmit={save}>
          <div class="editor-layout">
            <div class="editor-fields">
              <label class="editor-field">Theme name<Input required maxlength={40} bind:value={draft.name} /></label>
              <div class="editor-options">
                <label class="editor-field">Color scheme
                  <select bind:value={draft.scheme}><option value="dark">Dark</option><option value="light">Light</option></select>
                </label>
                <label class="editor-field">Density
                  <select bind:value={draft.density}>
                    <option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option>
                  </select>
                </label>
                <label class="editor-field"><span class="range-label">Corner radius <output>{draft.radius} px</output></span>
                  <input type="range" aria-label="Corner radius" min="0" max="24" bind:value={draft.radius} />
                </label>
                <label class="editor-field"><span class="range-label">Text size <output>{draft.textSize}%</output></span>
                  <input type="range" aria-label="Text size" min="90" max="130" bind:value={draft.textSize} />
                </label>
              </div>
              <fieldset>
                <legend>Colors</legend>
                <div class="color-grid">
                  {#each colorFields as [key, label] (key)}
                    <label class="color-field">
                      <input type="color" aria-label={label} bind:value={draft.colors[key]} />
                      <span>{label}<small>{draft.colors[key]}</small></span>
                    </label>
                  {/each}
                </div>
              </fieldset>
            </div>
            <div class="preview-column">
              <h3>Live preview</h3>
              <div class="sample" style={themeStyle(draft)} aria-label="Sample channel">
                <div class="sample-title"><MessageCircle size={16} /> General</div>
                <div class="sample-message">
                  <span class="sample-avatar">M</span>
                  <div><strong>Moana</strong><small>Today, 10:42 am</small><p>See you in voice.</p></div>
                </div>
                <div class="sample-selection"><Check size={14} /> General selected</div>
                <div class="sample-composer"><span>Message General</span><span><Send size={15} /></span></div>
                <div class="sample-statuses">
                  {#each sampleStatuses as [color, label] (color)}
                    <span style:--status={draft.colors[color]}>{label}</span>
                  {/each}
                </div>
              </div>
              <Checkbox label="Preview in app" bind:checked={() => previewInApp, togglePreview} />
              {#if readability < 4.5}
                <p class="form-error">Some text colors have low contrast against the selected surfaces.</p>
              {/if}
            </div>
          </div>
          {#if error}<p class="form-error" role="alert">{error}</p>{/if}
          <div class="theme-actions theme-footer">
            {#if editingId}<Button variant="destructive" onclick={() => { confirmDelete = true; }}>Delete theme</Button>{/if}
            <span class="flex-content"></span>
            <Button variant="outline" onclick={closeEditor}>Cancel</Button>
            <Button type="submit">Save theme</Button>
          </div>
        </form>
      </section>
    {/if}
  </div>
</main>

<Modal bind:open={confirmDelete} title="Delete custom theme?" description="This removes the theme from this device. If it is active, the app switches to Dark.">
  <div class="dialog-actions">
    <Button variant="outline" onclick={() => { confirmDelete = false; }}>Cancel</Button>
    <Button variant="destructive" onclick={deleteTheme}>Delete theme</Button>
  </div>
</Modal>

<style>
  .appearance-card { container-type: inline-size; display: grid; width: min(100%, 58rem); gap: 1rem; }
  .appearance-heading, .theme-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .appearance-heading { justify-content: space-between; }
  h2 { font-size: 1.15em; }
  h3, legend { font-weight: 600; }
  .theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 5.6rem), 1fr)); gap: .75rem .5rem; }
  .theme-tile { display: grid; min-width: 0; align-content: start; justify-items: center; gap: .33rem; padding: 4px; border-radius: var(--radius-md); }
  .swatch-card {
    display: grid;
    position: relative;
    align-items: center;
    width: 100%;
    max-width: 7.5rem;
    height: 5.4rem;
    padding: .65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--background);
  }
  .swatches { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; width: min(100%, 2.8rem); }
  .swatches span { height: .62rem; border-radius: min(var(--radius), 1rem); background: var(--swatch); }
  .theme-name { max-width: 100%; color: var(--muted-foreground); font-size: var(--type-caption); line-height: 1.25; text-align: center; overflow-wrap: anywhere; }
  .theme-tile[aria-pressed="true"] .swatch-card { outline: 2px solid var(--tile-ring); outline-offset: 2px; }
  .theme-tile { --tile-ring: var(--ring); }
  .theme-tile:is(:hover, [aria-pressed="true"]) .theme-name { color: var(--foreground); }
  .theme-tile[aria-pressed="true"] .theme-name { font-weight: 700; }
  .selected-mark {
    position: absolute;
    inset: .36rem .36rem auto auto;
    display: grid;
    place-items: center;
    width: 1.15rem;
    height: 1.15rem;
    border-radius: min(var(--radius), 50%);
    color: var(--primary-foreground);
    background: var(--primary);
  }
  .custom-themes, .theme-filters, .theme-footer { padding-top: .8rem; border-top: 1px solid var(--border); }
  .custom-themes { display: grid; gap: .65rem; }
  .theme-editor, .editor-fields, .preview-column { display: grid; gap: 1rem; min-width: 0; align-content: start; }
  .editor-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .9fr); align-items: start; gap: 1.1rem; }
  .editor-options, .color-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
  .editor-field { display: grid; gap: .25rem; min-width: 0; }
  .editor-field select { width: 100%; min-height: var(--control-height); padding-inline: .55rem; border: 1px solid var(--input); border-radius: var(--radius-lg); background: var(--background); }
  .editor-field input[type="range"] { width: 100%; min-height: var(--control-height); accent-color: var(--primary); }
  .range-label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 .3rem; }
  output, .color-field small { color: var(--muted-foreground); font-size: var(--type-caption); }
  legend { margin-bottom: .5rem; }
  .color-field { display: flex; align-items: center; gap: .45rem; font-size: var(--type-small); line-height: 1.24; }
  .color-field input { width: 2rem; height: 2rem; flex: none; cursor: pointer; }
  .color-field small { display: block; font-family: var(--font-mono); }
  .preview-column { position: sticky; top: 0; }
  .sample {
    display: grid; gap: var(--ui-gap); padding: var(--ui-gap); border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 1.4); background: var(--background); color: var(--foreground);
    font-size: calc(.9375rem * var(--text-scale));
  }
  .sample-title, .sample-selection, .sample-composer { display: flex; align-items: center; gap: .5rem; }
  .sample-title { padding: .4rem .6rem; border-radius: var(--radius); background: var(--muted); font-weight: 650; }
  .sample-message { display: flex; gap: .55rem; padding: calc(var(--ui-gap) * .65); border-radius: var(--radius); background: var(--card); }
  .sample-message small { display: block; color: var(--muted-foreground); }
  .sample-avatar { display: grid; place-items: center; width: 2em; height: 2em; border-radius: min(calc(var(--radius) * 2), 50%); background: var(--secondary); color: var(--secondary-foreground); }
  .sample-selection { padding: .25rem .5rem; border-radius: var(--radius); background: var(--accent); color: var(--accent-foreground); }
  .sample-composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  .sample-composer span { display: flex; align-items: center; gap: .5rem; min-height: var(--control-height); padding-inline: .5rem; border: 1px solid var(--input); border-radius: var(--radius); color: var(--muted-foreground); }
  .sample-composer span:last-child { border-color: transparent; background: var(--primary); color: var(--primary-foreground); }
  .sample-statuses { display: flex; flex-wrap: wrap; gap: .4em 1em; font-size: .8em; }
  .sample-statuses span { display: inline-flex; align-items: center; gap: .35em; }
  .sample-statuses span::before { content: ""; width: .65em; height: .65em; border-radius: min(var(--radius), 50%); background: var(--status); }
  @container (max-width: 34rem) {
    .editor-layout { display: flex; flex-direction: column; }
    .preview-column { position: static; order: -1; width: 100%; }
    .editor-fields { width: 100%; }
  }
  @container (max-width: 16rem) { .color-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
