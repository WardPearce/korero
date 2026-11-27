<script lang="ts">
  import { MessageCircle } from "@lucide/svelte";
  import ChatMessage from "#lib/components/chat/ChatMessage.svelte";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { defaultChatDisplay, getChatDisplay, type ChatDisplay } from "#lib/chat/chat-display";

  const display = getChatDisplay();
  const densities = [
    { value: "comfortable", label: "Comfortable" },
    { value: "compact", label: "Compact" },
  ] as const;
  const sample = [
    { id: 1, senderId: "moana", name: "Moana", createdAt: new Date(2026, 0, 1, 10, 42).getTime(), text: "Anyone joining voice later?" },
    { id: 2, senderId: "moana", name: "Moana", createdAt: new Date(2026, 0, 1, 10, 43).getTime(), text: "I’ll be in the Lounge." },
    { id: 3, senderId: "ari", name: "Ari", createdAt: new Date(2026, 0, 1, 10, 44).getTime(), text: "See you there!" },
  ];
  const isDefault = $derived(
    display.value.density === defaultChatDisplay.density &&
    display.value.showAvatars === defaultChatDisplay.showAvatars &&
    display.value.showTimestamps === defaultChatDisplay.showTimestamps &&
    display.value.groupMessages === defaultChatDisplay.groupMessages,
  );
  let saveFailed = $state(false);

  function update(changes: Partial<ChatDisplay>) {
    saveFailed = !display.update({ ...display.value, ...changes });
  }
</script>

<svelte:head><title>Chat · Korero.chat</title></svelte:head>

<main class="room-pane settings-pane">
  <header class="workspace-header">
    <div class="heading-icon"><MessageCircle size={19} aria-hidden="true" /></div>
    <h1>Chat</h1>
  </header>
  <div class="workspace settings-content">
    <section class="settings-card" aria-labelledby="display-heading">
      <div class="settings-row">
        <div class="settings-heading">
          <h2 id="display-heading">Message display</h2>
          <p class="field-hint">Applies to channel chats and direct messages on this device.</p>
        </div>
        <Button variant="outline" disabled={isDefault && !saveFailed} onclick={() => update(defaultChatDisplay)}>Reset to defaults</Button>
      </div>
      <div class="display-layout">
        <div class="display-controls">
          <SelectField label="Message density" options={densities}
            bind:value={() => display.value.density, (density) => update({ density })} />
          <div>
            <Checkbox label="Show avatars" bind:checked={() => display.value.showAvatars, (showAvatars) => update({ showAvatars })} />
            <Checkbox label="Show timestamps" bind:checked={() => display.value.showTimestamps, (showTimestamps) => update({ showTimestamps })} />
            <Checkbox label="Group consecutive messages" bind:checked={() => display.value.groupMessages, (groupMessages) => update({ groupMessages })} />
            <p class="field-hint">Groups messages from the same person sent within five minutes of each other.</p>
          </div>
        </div>
        <div class="display-preview">
          <h3 id="chat-preview-heading">Live preview</h3>
          <div class="chat-preview" role="group" aria-labelledby="chat-preview-heading">
            {#each sample as message, index (message.id)}
              <ChatMessage {message} previous={sample[index - 1]} name={message.name} showProfilePicture={false}>
                <p>{message.text}</p>
              </ChatMessage>
            {/each}
          </div>
        </div>
      </div>
      {#if saveFailed}
        <p class="form-error" role="alert">Chat settings could not be saved. Changes apply until you reload the app.</p>
      {/if}
    </section>
  </div>
</main>

<style>
  .display-layout { display: grid; gap: var(--settings-padding); align-items: start; }
  .display-controls { display: grid; gap: .65rem; }
  .display-preview h3 { font-size: var(--type-small); }
  .chat-preview {
    margin-block-start: .4rem;
    padding-block: .3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--background);
  }
  @container settings-pane (min-width: 44rem) {
    .display-layout { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
  }
</style>
