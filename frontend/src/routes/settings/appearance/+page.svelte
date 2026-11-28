<script lang="ts">
  import { downloadFile } from "#lib/download-file";
  import { Check, Download, Image as ImageIcon, MessageCircle, Palette, Pencil, Plus, Send, Smile, Upload } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { getWorkspace } from "#lib/workspace";
  import {
    applyAppearance, builtInThemes, colorFields, contrast, defaultTheme, parseTheme, playfulThemes,
    swatchColors, themeFor, themeStyle, type Appearance, type SavedTheme, type Theme,
  } from "#lib/theme";

  const sampleStatuses = [
    ["success", "Success"], ["danger", "Danger"], ["warning", "Warning"], ["info", "Info"],
  ] as const;
  const themeFilters = [
    ["all", "All"], ["dark", "Dark"], ["light", "Light"], ["playful", "Playful"],
  ] as const;
  const schemeOptions = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ] as const;
  const densityOptions = [
    { value: "compact", label: "Compact" },
    { value: "comfortable", label: "Comfortable" },
    { value: "spacious", label: "Spacious" },
  ] as const;

  const settings = getWorkspace();
  let appearance = $derived(settings.appearance);
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
  let saving = $state(false);
  let fileInput: HTMLInputElement;
  let workspace: HTMLDivElement;
  let importButton = $state<HTMLButtonElement | null>(null);
  let editorTrigger: HTMLElement | null = null;
  let imageUrl = $state("");
  let imageInput = $state<HTMLInputElement | null>(null);

  const backgroundMaxBytes = 10 * 1024 * 1024;
  const backgroundMaxDimension = 1920;

  let readability = $derived.by(() => {
    if (!draft) return 0;
    const { text, mutedText, background, panel, surface } = draft.colors;
    return Math.min(...[text, mutedText].flatMap((color) => [background, panel, surface].map((base) => contrast(color, base))));
  });

  $effect(() => {
    if (draft && previewInApp) applyAppearance(appearance, draft);
  });

  onDestroy(() => {
    if (previewInApp) applyAppearance(appearance);
  });

  async function updateAppearance(edit: (appearance: Appearance) => Appearance, message: string) {
    if (saving) return false;
    saving = true;
    error = "";
    try {
      status = await settings.updateAppearance(edit) ? message : "This device blocked storage. Changes apply until you close or reload the app.";
      return true;
    } catch (cause) {
      status = "";
      error = cause instanceof Error ? cause.message : "Could not sync your appearance.";
      return false;
    } finally {
      saving = false;
    }
  }

  function select(theme: SavedTheme) {
    previewInApp = false;
    void updateAppearance((current) => {
      const next = { ...current, active: theme.id };
      if (themeFor(next).id !== theme.id) throw new Error("This theme was deleted on another device.");
      return next;
    }, theme.name + " applied.");
  }

  function toggleGlassmorphism(glassmorphism: boolean) {
    void updateAppearance((current) => ({ ...current, glassmorphism }),
      glassmorphism ? "Frosted glass enabled." : "Frosted glass disabled.");
  }

  function applyImageUrl(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value.trim();
    if (draft) draft.image = /^https?:\/\//.test(value) ? value : "";
  }

  function removeBackground() {
    if (draft) draft.image = "";
    imageUrl = "";
  }

  async function chooseBackground(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !draft) return;
    try {
      if (file.size > backgroundMaxBytes) throw new Error("Choose an image smaller than 10 MiB.");
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      try {
        const scale = Math.min(1, backgroundMaxDimension / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This device could not prepare the image.");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        draft.image = canvas.toDataURL("image/jpeg", 0.8);
        imageUrl = "";
      } finally {
        bitmap.close();
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Choose a readable PNG, JPEG, or WebP image.";
    }
  }

  function startEditor(theme: Theme, trigger: HTMLElement | null, id?: string) {
    editorTrigger = trigger;
    draft = { ...theme, colors: { ...theme.colors } };
    imageUrl = theme.image && !theme.image.startsWith("data:") ? theme.image : "";
    editingId = id;
    status = "";
    error = "";
  }

  function createTheme(event: MouseEvent & { currentTarget: HTMLElement }) {
    startEditor({ ...active, name: "My " + active.name.slice(0, 37) }, event.currentTarget);
  }

  function customizeTheme(event: MouseEvent & { currentTarget: HTMLElement }) {
    if (activeIsCustom) startEditor(active, event.currentTarget, active.id);
    else createTheme(event);
  }

  function togglePreview(checked: boolean) {
    previewInApp = checked;
    if (!checked) applyAppearance(appearance);
  }

  async function closeEditor() {
    togglePreview(false);
    draft = undefined;
    editingId = undefined;
    confirmDelete = false;
    error = "";
    await tick();
    workspace?.scrollTo(0, 0);
    editorTrigger?.focus({ preventScroll: true });
    editorTrigger = null;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const theme = parseTheme(draft);
    if (!theme) {
      error = "Enter a theme name and valid appearance values.";
      return;
    }
    const editing = editingId !== undefined;
    const id = editingId ?? "custom-" + crypto.randomUUID();
    const saved = { ...theme, id };
    if (await updateAppearance((current) => {
      if (editing && !current.custom.some((entry) => entry.id === id)) throw new Error("This theme was deleted on another device.");
      const custom = editing ? current.custom.map((entry) => entry.id === id ? saved : entry) : [...current.custom, saved];
      return { ...current, active: id, custom };
    }, theme.name + " saved and applied.")) await closeEditor();
  }

  async function deleteTheme() {
    const id = editingId;
    if (!id) return;
    confirmDelete = false;
    if (await updateAppearance((current) => ({
      ...current,
      active: current.active === id ? defaultTheme.id : current.active,
      custom: current.custom.filter((entry) => entry.id !== id),
    }), "Theme deleted.")) await closeEditor();
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
      if (!draft) startEditor(theme, importButton);
    } catch {
      error = "Choose a valid Korero.chat theme JSON file.";
    }
  }

  async function exportTheme() {
    const theme = parseTheme(active);
    if (!theme) return;
    const name = theme.name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme";
    try {
      await downloadFile(name + ".json", new Blob([JSON.stringify({ version: 1, theme }, null, 2)], { type: "application/json" }));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not export the theme.";
    }
  }
</script>

<svelte:head><title>Appearance · Korero.chat</title></svelte:head>

{#snippet themeTile(theme: SavedTheme)}
  <button class="theme-tile" type="button" aria-pressed={active.id === theme.id} disabled={saving} onclick={() => select(theme)}>
    <span class="tile-preview" style={themeStyle(theme)} aria-hidden="true">
      <span class="tile-window">
        <span class="tile-sidebar"><span></span><span></span><span></span></span>
        <span class="tile-channel"><span></span><span></span><span></span></span>
      </span>
    </span>
    <span class="tile-caption">
      <span class="theme-name">{theme.name}</span>
      {#if active.id === theme.id}<span class="selected-mark"><Check size={13} strokeWidth={3} aria-hidden="true" /></span>{/if}
    </span>
    <span class="tile-colors" aria-hidden="true">
      {#each swatchColors as color (color)}
        <span style:--swatch={theme.colors[color]}></span>
      {/each}
    </span>
  </button>
{/snippet}

{#snippet channelPreview(theme: Theme, showStatuses = false)}
  <div class="sample theme-sample" data-glass={appearance.glassmorphism ? "" : undefined} data-image={theme.image ? "" : undefined} style={themeStyle(theme)} aria-label="Sample channel" role="group">
    <div class="sample-sidebar">
      <div class="sample-header"><strong>Korero</strong></div>
      <div class="sample-channels">
        <span class="sample-row" data-selected>General</span>
        <span class="sample-row">Lounge</span>
      </div>
    </div>
    <div class="sample-channel">
      <div class="sample-header">
        <span class="sample-heading-icon" aria-hidden="true"><MessageCircle size={15} /></span>
        <div><small>Channel chat</small><strong>General</strong></div>
      </div>
      <div class="sample-log">
        <div class="sample-message">
          <span class="sample-avatar" aria-hidden="true">M</span>
          <div><div class="sample-meta"><strong>Moana</strong> <small>10:42 am</small></div><p>See you in voice.</p></div>
        </div>
        {#if showStatuses}
          <div class="sample-statuses">
            {#each sampleStatuses as [color, label] (color)}
              <span style:--status={theme.colors[color]}>{label}</span>
            {/each}
          </div>
        {/if}
      </div>
      <div class="sample-composer">
        <span class="sample-input">Message General</span>
        <span class="sample-icon" aria-hidden="true"><Smile size={15} /></span>
        <span class="sample-send" aria-hidden="true"><Send size={15} /></span>
      </div>
    </div>
  </div>
{/snippet}

<main class="room-pane settings-pane appearance-pane">
  <header class="workspace-header">
    <div class="heading-icon"><Palette size={19} aria-hidden="true" /></div>
    <h1>Appearance</h1>
    <div class="theme-actions page-actions">
      <Button bind:ref={importButton} variant="outline" disabled={!!draft} onclick={() => fileInput.click()}><Upload /> Import</Button>
      <Button disabled={!!draft} onclick={createTheme}><Plus /> Create theme</Button>
      <input type="file" accept=".json,application/json" hidden bind:this={fileInput} onchange={importTheme} />
    </div>
  </header>
  <div class="workspace settings-content" bind:this={workspace}>
    <section class="settings-card current-theme" aria-labelledby="current-theme-heading">
      <div class="current-theme-details">
        <h2 id="current-theme-heading">Current theme</h2>
        <p class="current-theme-name">{active.name}</p>
        <div class="theme-actions">
          <Button variant="outline" disabled={!!draft} onclick={customizeTheme}
            aria-label={activeIsCustom ? "Edit theme" : "Customize selected theme"}>
            <Pencil /> {activeIsCustom ? "Edit theme" : "Customize"}
          </Button>
          <Button variant="ghost" aria-label="Export selected theme" onclick={exportTheme}><Download /> Export</Button>
        </div>
        <Checkbox label="Frosted glass" disabled={saving} bind:checked={() => appearance.glassmorphism, toggleGlassmorphism} />
        <p class="field-hint theme-status" role="status">{status}</p>
      </div>
      {@render channelPreview(active)}
      {#if error && !draft}<p class="form-error" role="alert">{error}</p>{/if}
    </section>

    {#if draft}
      <section class="settings-card appearance-card" aria-labelledby="editor-heading">
        <h2 id="editor-heading" tabindex="-1" {@attach (element) => element.focus()}>{editingId ? "Edit theme" : "Create a custom theme"}</h2>
        <form class="theme-editor" onsubmit={save}>
          <div class="editor-layout">
            <div class="editor-fields">
              <label class="editor-field">Theme name<Input required maxlength={40} bind:value={draft.name} /></label>
              <div class="editor-options">
                <SelectField label="Color scheme" options={schemeOptions} bind:value={draft.scheme} />
                <SelectField label="Density" options={densityOptions} bind:value={draft.density} />
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
              <fieldset>
                <legend>Background image</legend>
                <div class="background-controls">
                  <label class="editor-field background-url">
                    <span>Image URL</span>
                    <Input type="url" placeholder="https://example.com/background.jpg" bind:value={imageUrl} oninput={applyImageUrl} />
                  </label>
                  <span class="background-or">or</span>
                  <Button variant="outline" onclick={() => imageInput?.click()}><ImageIcon /> Choose image</Button>
                  <input type="file" accept="image/*" hidden bind:this={imageInput} onchange={chooseBackground} />
                </div>
                {#if draft.image}
                  <div class="background-preview">
                    <img src={draft.image} alt="" aria-hidden="true" />
                    <span>{draft.image.startsWith("data:") ? "Uploaded image" : "Image URL"}</span>
                    <Button variant="ghost" onclick={removeBackground}>Remove</Button>
                  </div>
                {/if}
                <p class="field-hint">The background becomes slightly transparent so the image shows through. Frosted glass blurs it.</p>
              </fieldset>
            </div>
            <div class="preview-column">
              <h3>Live preview</h3>
              {@render channelPreview(draft, true)}
              <Checkbox label="Preview in app" bind:checked={() => previewInApp, togglePreview} />
              {#if readability < 4.5}
                <p class="form-error">Some text colors have low contrast against the selected surfaces.</p>
              {/if}
            </div>
          </div>
          {#if error}<p class="form-error" role="alert">{error}</p>{/if}
          <div class="theme-actions theme-footer">
            {#if editingId}<Button variant="destructive" disabled={saving} onclick={() => { confirmDelete = true; }}>Delete theme</Button>{/if}
            <span class="flex-content"></span>
            <Button variant="outline" disabled={saving} onclick={closeEditor}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save theme"}</Button>
          </div>
        </form>
      </section>
    {/if}

    {#if appearance.custom.length}
      <section class="settings-card theme-gallery" aria-labelledby="custom-heading">
        <h2 id="custom-heading">My themes</h2>
        <div class="theme-grid">
          {#each appearance.custom as theme (theme.id)}
            {@render themeTile(theme)}
          {/each}
        </div>
      </section>
    {/if}

    <section class="settings-card theme-gallery" aria-labelledby="themes-heading">
      <div class="gallery-heading">
        <h2 id="themes-heading">Built-in themes</h2>
        <div class="theme-actions theme-filters" role="group" aria-label="Filter built-in themes">
          {#each themeFilters as [value, label] (value)}
            <button type="button" aria-pressed={filter === value} aria-controls="built-in-themes"
              onclick={() => { filter = value; }}>{label}</button>
          {/each}
        </div>
      </div>
      <div id="built-in-themes" class="theme-grid">
        {#each visibleThemes as theme (theme.id)}
          {@render themeTile(theme)}
        {/each}
      </div>
    </section>
  </div>
</main>

<Modal bind:open={confirmDelete} title="Delete custom theme?"
  description={`This removes the theme from this device. If it is active, the app switches to ${defaultTheme.name}.`}>
  <div class="dialog-actions">
    <Button variant="outline" onclick={() => { confirmDelete = false; }}>Cancel</Button>
    <Button variant="destructive" onclick={deleteTheme}>Delete theme</Button>
  </div>
</Modal>

<style>
  .appearance-pane > .workspace-header { flex-wrap: wrap; }
  .theme-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .page-actions { flex: none; max-width: 100%; margin-inline-start: auto; }
  .current-theme {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    align-items: center;
    gap: clamp(1.25rem, 3cqi, 3rem);
    padding: clamp(var(--settings-padding), 2.5cqi, 2rem);
    background: linear-gradient(115deg, color-mix(in srgb, var(--glass-card, var(--card)) 91%, var(--primary)), var(--glass-card, var(--card)) 65%);
    box-shadow: var(--glass-highlight, none);
  }
  .current-theme-details { display: grid; justify-items: start; gap: .6rem; min-width: 0; }
  .current-theme-details h2 { color: var(--muted-foreground); font-size: var(--type-small); }
  .current-theme-name {
    margin-bottom: .3rem;
    font-size: calc(clamp(1.65rem, 3.5cqi, 3rem) * var(--text-scale));
    font-weight: 650;
    letter-spacing: -.035em;
    line-height: 1.08;
    overflow-wrap: anywhere;
  }
  .theme-status { overflow-wrap: anywhere; }
  .theme-status:empty { position: absolute; }
  .current-theme > .form-error { grid-column: 1 / -1; }

  .theme-gallery { display: grid; gap: .85rem; }
  .gallery-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; }
  h3, legend { font-weight: 600; }
  .theme-filters { gap: .2rem; padding: .2rem; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--muted); }
  .theme-filters button {
    min-height: max(32px, calc(var(--control-height) - 4px));
    padding: .25rem .65rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
    font-size: var(--type-small);
    font-weight: 500;
  }
  .theme-filters button:hover { background: var(--control-hover); color: var(--foreground); }
  .theme-filters button[aria-pressed="true"] { border-color: var(--primary); background: var(--control-selected); color: var(--foreground); }
  .theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 8.25rem), 1fr)); gap: clamp(.6rem, 1.15cqi, 1rem); }
  .theme-tile {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: .4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--glass-card, var(--card));
    text-align: start;
  }
  .theme-tile:hover { border-color: var(--input); background: var(--control-hover); }
  .theme-tile[aria-pressed="true"] { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
  .tile-preview {
    display: grid;
    align-content: end;
    width: 100%;
    height: clamp(4.6rem, 7.4cqi, 6.25rem);
    padding: .65rem .65rem 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: min(var(--radius), .5rem);
    background-color: color-mix(in srgb, var(--background) 85%, var(--primary));
    background-image: var(--theme-image, none);
    background-size: cover;
    background-position: center;
  }
  .tile-window {
    display: grid;
    grid-template-columns: 30% minmax(0, 1fr);
    height: clamp(3.8rem, 6.3cqi, 5.35rem);
    overflow: hidden;
    border: 1px solid var(--border);
    border-bottom: 0;
    border-radius: min(var(--radius), .45rem) min(var(--radius), .45rem) 0 0;
    background: var(--background);
  }
  .tile-sidebar, .tile-channel { display: flex; flex-direction: column; min-width: 0; gap: .35rem; padding: .45rem .3rem; }
  .tile-sidebar { background: var(--muted); border-inline-end: 1px solid var(--border); }
  .tile-channel { padding-inline: .4rem; }
  .tile-sidebar > span, .tile-channel > span { height: .28rem; border-radius: min(var(--radius), .15rem); background: var(--input); }
  .tile-sidebar > span:nth-child(2) { height: .5rem; background: var(--accent); }
  .tile-sidebar > span:last-child { width: 74%; }
  .tile-channel > span:first-child { width: 56%; background: var(--foreground); }
  .tile-channel > span:nth-child(2) { height: .64rem; width: 85%; background: var(--card); }
  .tile-channel > span:last-child { width: 37%; margin-top: auto; background: var(--primary); }
  .tile-caption {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: .3rem;
    min-height: 2.35rem;
    padding: .35rem .2rem;
  }
  .theme-name { min-width: 0; font-size: var(--type-small); font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
  .tile-colors {
    display: flex;
    gap: 2px;
    margin: auto .2rem .25rem;
    overflow: hidden;
    border-radius: min(var(--radius), .25rem);
  }
  .tile-colors > span { flex: 1; height: .35rem; background: var(--swatch); }
  .selected-mark {
    display: grid;
    flex: none;
    place-items: center;
    width: 1.15rem;
    height: 1.15rem;
    border-radius: min(var(--radius), 50%);
    color: var(--primary-foreground);
    background: var(--primary);
  }
  .appearance-card {
    container-type: inline-size;
    gap: 1rem;
  }
  .theme-footer { padding-top: .8rem; border-top: 1px solid var(--border); }
  .theme-editor, .editor-fields, .preview-column { display: grid; gap: 1rem; min-width: 0; align-content: start; }
  .editor-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .9fr); align-items: start; gap: 1.1rem; }
  .editor-options, .color-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
  .editor-field { display: grid; gap: .25rem; min-width: 0; }
  .editor-field input[type="range"] { width: 100%; min-height: var(--control-height); accent-color: var(--primary); }
  .range-label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 .3rem; }
  output, .color-field small { color: var(--muted-foreground); font-size: var(--type-caption); }
  legend { margin-bottom: .5rem; }
  .color-field { display: flex; align-items: center; gap: .45rem; font-size: var(--type-small); line-height: 1.24; }
  .color-field input { width: 2rem; height: 2rem; flex: none; cursor: pointer; }
  .color-field small { display: block; font-family: var(--font-mono); }
  .background-controls { display: flex; align-items: flex-end; flex-wrap: wrap; gap: .5rem; }
  .background-url { flex: 1 1 14rem; }
  .background-or { align-self: center; color: var(--muted-foreground); font-size: var(--type-small); }
  .background-preview { display: flex; align-items: center; gap: .6rem; margin-top: .6rem; }
  .background-preview img {
    width: 4rem;
    height: 2.5rem;
    flex: none;
    object-fit: cover;
    border: 1px solid var(--border);
    border-radius: min(var(--radius), .5rem);
  }
  .background-preview span { flex: 1; min-width: 0; color: var(--muted-foreground); font-size: var(--type-small); overflow-wrap: anywhere; }
  .preview-column { position: sticky; top: 0; }
  .sample {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2.5fr);
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 1.4);
    background: var(--background);
    background-image: var(--glass-backdrop, none);
    color: var(--foreground);
    /* Scale the mock down on narrow containers so the two-pane preview stays
       proportional on mobile instead of squashing its desktop proportions. */
    font-size: calc(clamp(.68rem, 3cqi, .875rem) * var(--text-scale));
    overflow-wrap: anywhere;
  }
  .sample[data-image] {
    background-color: var(--background);
    background-image: linear-gradient(color-mix(in srgb, var(--background) 90%, transparent), color-mix(in srgb, var(--background) 90%, transparent)), var(--theme-image);
    background-size: cover, cover;
    background-position: center, center;
  }
  .sample[data-image]:not([data-glass]) .sample-sidebar {
    background: color-mix(in srgb, var(--muted) 88%, transparent);
  }
  .sample[data-image]:not([data-glass]) .sample-composer {
    background: color-mix(in srgb, var(--card) 90%, transparent);
  }
  /* Mirrors the real channel pane, chat header, message row and composer at preview scale. */
  .sample-sidebar, .sample-channel { display: flex; flex-direction: column; min-width: 0; }
  .sample-sidebar { border-inline-end: 1px solid var(--border); background: var(--glass-panel, var(--muted)); }
  .sample-header {
    display: flex; align-items: center; gap: .6em; min-height: 3.6em;
    padding: .55em calc(var(--ui-gap) * .7);
    border-bottom: 1px solid var(--border);
  }
  .sample[data-glass] .sample-header {
    background: var(--glass-card, transparent); border-color: var(--glass-edge, var(--border)); box-shadow: var(--glass-highlight, none);
  }
  .sample-header strong { display: block; overflow: hidden; font-size: 1.05em; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
  .sample-header > div { display: grid; min-width: 0; }
  .sample-header small { color: var(--muted-foreground); font-size: .75em; }
  .sample-heading-icon {
    display: grid; flex: none; place-items: center; width: 2.2em; height: 2.2em;
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card);
  }
  .sample-channels { display: grid; gap: .4em; padding: .6em; }
  .sample-row {
    display: flex; align-items: center; min-height: 2.5em; min-width: 0; padding: .25em .6em .25em 1.6em;
    border: 1px solid var(--border); border-radius: var(--radius-md);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sample-row[data-selected] {
    border-color: var(--primary); background: var(--control-selected);
    box-shadow: inset 3px 0 var(--primary); font-weight: 700;
  }
  .sample-log { display: grid; flex: 1; align-content: start; gap: .5em; padding-block: .35em; }
  .sample-message { display: grid; grid-template-columns: 2em minmax(0, 1fr); align-items: start; gap: .6em; padding: .4em calc(var(--ui-gap) * .7); }
  .sample-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 .5em; }
  .sample-meta small { color: var(--muted-foreground); font-size: .8em; }
  .sample-avatar {
    display: grid; place-items: center; width: 2em; height: 2em;
    border: 1px solid var(--border); border-radius: var(--avatar-radius);
    background: var(--secondary); color: var(--secondary-foreground); font-size: 1em;
  }
  .sample-composer {
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: .45em;
    padding: calc(var(--ui-gap) * .6); border-top: 1px solid var(--border); background: var(--card);
  }
  .sample[data-glass] .sample-composer { background: var(--glass-card, var(--card)); border-color: var(--glass-edge, var(--border)); }
  .sample-composer > span { display: flex; align-items: center; height: 2.4em; border-radius: var(--radius-md); }
  .sample-input {
    min-width: 0; padding-inline: .65em; border: 1px solid var(--input); background: var(--background);
    color: var(--muted-foreground); overflow: hidden; white-space: nowrap;
  }
  .sample-icon, .sample-send { justify-content: center; width: 2.4em; }
  .sample-icon { border: 1px solid var(--input); background: var(--background); }
  .sample-send { background: var(--primary); color: var(--primary-foreground); }
  .sample-statuses { display: flex; flex-wrap: wrap; gap: .4em 1em; padding-inline: calc(var(--ui-gap) * .7); font-size: .8em; }
  .sample-statuses span { display: inline-flex; align-items: center; gap: .35em; }
  .sample-statuses span::before { content: ""; width: .65em; height: .65em; border-radius: min(var(--radius), 50%); background: var(--status); }
  @container (max-width: 40rem) {
    .current-theme { grid-template-columns: minmax(0, 1fr); gap: .8rem; }
  }
  @container (max-width: 28rem) {
    .theme-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 7.5rem), 1fr)); }
    .theme-filters button { padding-inline: .4rem; font-size: var(--type-caption); }
    .sample { grid-template-columns: minmax(5.25rem, 1fr) minmax(0, 2.5fr); }
    .sample-row { padding-inline-start: .6em; }
  }
  @container (max-width: 22.5rem) {
    .page-actions { margin-inline-start: 0; }
    .sample { grid-template-columns: minmax(0, 1fr); }
    .sample-sidebar { border-inline-end: 0; border-bottom: 1px solid var(--border); }
    .sample-sidebar > .sample-header { display: none; }
    .sample-channels { display: flex; flex-wrap: wrap; }
    .sample-row { flex: 1; }
  }
  @container (max-width: 34rem) {
    .editor-layout { display: flex; flex-direction: column; }
    .preview-column { position: static; order: -1; width: 100%; }
    .editor-fields { width: 100%; }
  }
  @container (max-width: 16rem) { .color-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
