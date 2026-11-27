<script lang="ts">
  import { Bold, Code, Italic, List, ListOrdered, Paperclip, Quote, Send, Smile, SquareCode, Strikethrough, Underline, X } from "@lucide/svelte";
  import { Tipex, type TipexEditor } from "@friendofsvelte/tipex";
  import { Placeholder } from "@tiptap/extensions";
  import StarterKit from "@tiptap/starter-kit";
  import { onDestroy, tick } from "svelte";
  import type { Picker } from "emoji-picker-element";
  import emojiData from "emoji-picker-element-data/en/github/data.json?url";
  import { buttonVariants, Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import IconButton from "#lib/components/IconButton.svelte";
  import { uploadAttachment } from "#lib/chat/chat-attachments";
  import { maxChatHtmlLength, maxChatTextLength, sanitizeChatHtml } from "#lib/chat/rich-chat";
  import { getWorkspace } from "#lib/workspace";

  type DirectComposer = { busy: boolean; maxBytes: number; send: (text: string, html?: string) => Promise<boolean> };
  let { channelId, channelName, direct, enabled }: { enabled: boolean } & (
    { channelId: string; channelName: string; direct?: never } |
    { channelId?: never; channelName?: never; direct: DirectComposer }
  ) = $props();
  const workspace = getWorkspace();
  let message = $state("");
  let editor = $state.raw<TipexEditor>();
  let file = $state<File>();
  let field = $state<HTMLInputElement | null>(null);
  let fileInput = $state<HTMLInputElement>();
  let pickerOpen = $state(false);
  let formattingError = $state("");
  const attaching = $derived(!direct && workspace.maxAttachmentBytes > 0 && workspace.view.snapshot?.canAttachFiles !== false);
  const busy = $derived(direct ? direct.busy : Boolean(workspace.pending));
  const rich = $derived(Boolean(direct) || workspace.richChat);
  const label = $derived(direct ? "Encrypted message" : "Channel message");
  const sendLabel = $derived(direct ? "Send direct message" : "Send message");
  const placeholder = $derived(direct ? "Write a direct message"
    : enabled ? `Message #${channelName}` : "Join a channel to send a message");
  const textLimit = $derived(direct?.maxBytes ?? maxChatTextLength);
  const draftTooLong = $derived(message.length > textLimit);
  const extensions = [
    StarterKit.configure({ heading: false, horizontalRule: false, trailingNode: false,
      link: { openOnClick: false, defaultProtocol: "https" } }),
    Placeholder.configure({ placeholder: () => placeholder, showOnlyWhenEditable: false }),
  ];

  type Editor = NonNullable<TipexEditor>;
  const formatting = [
    { label: "Bold", icon: Bold, mark: "bold", apply: (draft: Editor) => draft.chain().focus().toggleBold().run() },
    { label: "Italic", icon: Italic, mark: "italic", apply: (draft: Editor) => draft.chain().focus().toggleItalic().run() },
    { label: "Underline", icon: Underline, mark: "underline", apply: (draft: Editor) => draft.chain().focus().toggleUnderline().run() },
    { label: "Strikethrough", icon: Strikethrough, mark: "strike", apply: (draft: Editor) => draft.chain().focus().toggleStrike().run() },
    { label: "Inline code", icon: Code, mark: "code", apply: (draft: Editor) => draft.chain().focus().toggleCode().run() },
    { label: "Code block", icon: SquareCode, mark: "codeBlock", apply: (draft: Editor) => draft.chain().focus().toggleCodeBlock().run() },
    { label: "Quote", icon: Quote, mark: "blockquote", apply: (draft: Editor) => draft.chain().focus().toggleBlockquote().run() },
    { label: "Bulleted list", icon: List, mark: "bulletList", apply: (draft: Editor) => draft.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrdered, mark: "orderedList", apply: (draft: Editor) => draft.chain().focus().toggleOrderedList().run() },
  ];

  $effect(() => {
    const editable = enabled && !busy;
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  });

  onDestroy(() => {
    const draft = editor;
    // TipTap can emit a final transaction during destruction.
    queueMicrotask(() => draft?.destroy());
  });

  function configureEditor({ editor: draft }: { editor: Editor }) {
    draft.setOptions({ editorProps: {
      attributes: { "aria-label": label, "aria-multiline": "true", role: "textbox" },
      transformPastedHTML: sanitizeChatHtml,
      handleKeyDown(view, event) {
        if (!draft.isEditable || event.key !== "Enter" || event.isComposing || view.composing || event.keyCode === 229 || event.shiftKey || event.altKey) return false;
        if (!direct && !event.ctrlKey && !event.metaKey && (draft.isActive("listItem") || draft.isActive("codeBlock"))) return false;
        view.dom.closest("form")?.requestSubmit();
        return true;
      },
    } });
  }

  function formattedMessage(draft: Editor) {
    let formatted = false;
    draft.state.doc.descendants((node) => {
      if (node.marks.length || (!node.isText && node.type.name !== "paragraph" && node.type.name !== "hardBreak")) formatted = true;
      return !formatted;
    });
    return formatted ? draft.getHTML() : undefined;
  }

  function attachFile(next?: File) {
    if (!next || !enabled || !attaching || busy) return;
    if (!validAttachment(next)) return;
    workspace.actionError = "";
    file = next;
  }

  function validAttachment(attachment: File) {
    if (!attachment.size || attachment.size > workspace.maxAttachmentBytes) {
      workspace.actionError = `Choose a non-empty file up to ${workspace.maxAttachmentBytes / 1048576} MiB.`;
      return false;
    }
    return true;
  }

  function dragOver(event: DragEvent) {
    if (direct || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = enabled && attaching && !busy ? "copy" : "none";
  }

  function dropFile(event: DragEvent) {
    if (direct || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (event.dataTransfer.files.length > 1) {
      workspace.actionError = "Attach one file per message.";
      return;
    }
    attachFile(event.dataTransfer.files[0]);
  }

  async function insertEmoji(emoji: string) {
    if (!enabled || busy) return;
    if (editor) {
      editor.chain().focus().insertContent({ type: "text", text: emoji }).run();
      pickerOpen = false;
      return;
    }
    const start = field?.selectionStart ?? message.length;
    const end = field?.selectionEnd ?? start;
    const next = message.slice(0, start) + emoji + message.slice(end);
    if (next.length > maxChatTextLength) return;
    message = next;
    pickerOpen = false;
    await tick();
    field?.focus();
    field?.setSelectionRange(start + emoji.length, start + emoji.length);
  }

  function mountPicker(container: HTMLDivElement) {
    let mounted = true;
    let picker: Picker | undefined;
    void import("emoji-picker-element").then(({ Picker }) => {
      if (!mounted) return;
      picker = new Picker({ dataSource: emojiData });
      picker.addEventListener("emoji-click", ({ detail }) => {
        if (detail.unicode) void insertEmoji(detail.unicode);
      });
      container.replaceChildren(picker);
    }).catch(() => {
      if (mounted) container.textContent = "Could not load the emoji picker.";
    });
    return () => {
      mounted = false;
      picker?.remove();
    };
  }

  async function send(event: SubmitEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!enabled || busy || draftTooLong || (!text && !file)) return;
    const markup = rich && text && editor ? formattedMessage(editor) : undefined;
    const html = markup ? sanitizeChatHtml(markup) || undefined : undefined;
    if ((markup?.length ?? 0) > maxChatHtmlLength || (html?.length ?? 0) > maxChatHtmlLength) {
      if (direct) {
        formattingError = "This message has too much formatting.";
        return;
      }
      workspace.actionError = "This message has too much formatting.";
      return;
    }
    if (direct) {
      formattingError = "";
      if (await direct.send(text, html)) {
        editor?.commands.clearContent();
        message = "";
      }
      return;
    }
    const snapshot = workspace.view.snapshot;
    if (!snapshot || channelId === undefined || snapshot.channelId !== channelId) return;
    const attachment = file;
    if (attachment && !attaching) {
      workspace.actionError = "Remove the attachment to send this message. Your role cannot upload files in this channel.";
      return;
    }
    if (attachment && !validAttachment(attachment)) return;
    const payload = { channelId, text, html };
    const limit = workspace.maxWebSocketBytes;
    if (!attachment && limit !== undefined) {
      const request = JSON.stringify({ version: 1, id: Number.MAX_SAFE_INTEGER, type: "message.send", payload });
      if (new TextEncoder().encode(request).byteLength > limit) {
        workspace.actionError = "This message exceeds the server’s size limit. Shorten it or remove some formatting.";
        return;
      }
    }
    const origin = workspace.serverOrigin;
    const sent = attachment
      ? await workspace.runAction("message", () => uploadAttachment(origin, snapshot.connectionId, channelId, text, attachment, html))
      : await workspace.run("message", "send_message", payload);
    if (sent) {
      editor?.commands.clearContent();
      message = "";
      file = undefined;
    }
  }
</script>

{#snippet actions()}
  {#if attaching}
    <input type="file" hidden bind:this={fileInput} onchange={(event) => {
      attachFile(event.currentTarget.files?.[0]);
      event.currentTarget.value = "";
    }} />
    <IconButton label="Attach file" disabled={!enabled || busy} onclick={() => fileInput?.click()}><Paperclip size={17} /></IconButton>
  {/if}
  <Popover.Root bind:open={pickerOpen}>
    <Popover.Trigger type="button" aria-label="Choose emoji" title="Choose emoji" disabled={!enabled || busy}
      class={buttonVariants({ variant: "outline", size: "icon", class: "icon-button" })}>
      <Smile size={17} />
    </Popover.Trigger>
    <Popover.Content side="top" align="end" class="w-auto p-0" aria-label="Emoji picker">
      {#if pickerOpen}<div class="picker" {@attach mountPicker}></div>{/if}
    </Popover.Content>
  </Popover.Root>
  <Button type="submit" class="send-button" variant="default" aria-label={sendLabel} title={sendLabel}
    disabled={!enabled || (!message.trim() && !file) || busy || draftTooLong}>
    <Send size={17} />
  </Button>
{/snippet}

<form class="composer" class:formatted={rich} onsubmit={send} ondragover={dragOver} ondrop={dropFile}>
  {#if file}
    <div class="attachment-draft">
      <Paperclip size={15} />
      <span class="truncate">{file.name}</span>
      <IconButton label="Remove attachment" disabled={busy} onclick={() => { file = undefined; }}><X size={15} /></IconButton>
    </div>
  {/if}
  {#if rich}
    <div class="rich-editor">
      <Tipex {extensions} autofocus={false} focal={false} controlComponent={null} bind:tipex={editor}
        oncreate={configureEditor} onupdate={({ editor: draft }) => {
          message = draft.getText({ blockSeparator: "\n" });
          formattingError = "";
        }} />
      <div class="editor-footer">
        <div class="formatting" role="group" aria-label="Message formatting">
          {#each formatting as format (format.mark)}
            <IconButton label={format.label} active={editor?.isActive(format.mark) ?? false} disabled={!enabled || busy || !editor}
              onclick={() => { if (editor) format.apply(editor); }}><format.icon size={15} /></IconButton>
          {/each}
        </div>
        <div class="message-actions">{@render actions()}</div>
      </div>
    </div>
    {#if formattingError}<p class="draft-limit" role="alert">{formattingError}</p>{/if}
    {#if draftTooLong}<p class="draft-limit" role="status">Messages can contain up to {textLimit} characters.</p>{/if}
  {:else}
    <Input aria-label={label} {placeholder} disabled={!enabled || busy} maxlength={maxChatTextLength}
      bind:ref={field} bind:value={message} />
    <div class="message-actions">{@render actions()}</div>
  {/if}
</form>

<style>
  .composer.formatted { grid-template-columns: minmax(0, 1fr); }
  .rich-editor { border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); }
  .rich-editor:focus-within { border-color: var(--input); }
  .rich-editor :global(.tiptap) { min-height: 2.6rem; max-height: min(12rem, 30dvh); overflow-y: auto; overflow-wrap: anywhere; white-space: pre-wrap; padding: .55rem .7rem; outline: none; }
  .rich-editor :global(.tiptap .is-editor-empty:first-child::before) { content: attr(data-placeholder); color: var(--muted-foreground); float: left; height: 0; pointer-events: none; }
  .rich-editor :global(.tiptap ul), .rich-editor :global(.tiptap ol) { padding-inline-start: 1.45em; }
  .rich-editor :global(.tiptap ul) { list-style: disc; }
  .rich-editor :global(.tiptap ol) { list-style: decimal; }
  .rich-editor :global(.tiptap a) { color: var(--primary); text-decoration: underline; }
  .rich-editor :global(.tiptap blockquote) { border-inline-start: 2px solid var(--border); padding-inline-start: .65em; }
  .rich-editor :global(.tiptap pre), .rich-editor :global(.tiptap code) { background: var(--muted); border-radius: var(--radius-sm); }
  .rich-editor :global(.tiptap pre) { overflow-x: auto; padding: .4rem .55rem; }
  .editor-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .2rem .5rem; padding: .25rem; border-top: 1px solid var(--border); }
  .formatting, .message-actions { display: flex; align-items: center; gap: .25rem; }
  .formatting { flex-wrap: wrap; }
  .message-actions { margin-inline-start: auto; }
  .formatting :global(.icon-button) { width: 1.8rem; height: 1.8rem; border-color: transparent; background: transparent; }
  .formatting :global(.icon-button:hover) { background: var(--control-hover); }
  .formatting :global(.icon-button[aria-pressed="true"]) { background: var(--control-selected); color: var(--primary); }
  .draft-limit { color: var(--destructive); font-size: var(--type-caption); }
  .attachment-draft { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
  .attachment-draft :global(svg) { flex: none; }
  .picker :global(emoji-picker) {
    width: min(315px, calc(100vw - 24px));
    height: min(360px, 54dvh);
    --background: var(--popover);
    --border-color: var(--border);
    --button-hover-background: var(--control-hover);
    --indicator-color: var(--primary);
    --input-border-color: var(--input);
    --input-font-color: var(--popover-foreground);
    --category-font-color: var(--muted-foreground);
    --outline-color: var(--ring);
  }
</style>
