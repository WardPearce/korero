<script lang="ts">
  import { AtSign, Bold, Code, CornerUpLeft, Italic, List, ListOrdered, Paperclip, Quote, Send, Smile, SquareCode, Strikethrough, Underline, Users, X } from "@lucide/svelte";
  import { Tipex, type TipexEditor } from "@friendofsvelte/tipex";
  import { Placeholder } from "@tiptap/extensions";
  import StarterKit from "@tiptap/starter-kit";
  import { onDestroy, tick } from "svelte";
  import { buttonVariants, Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import EmojiPicker from "#lib/components/EmojiPicker.svelte";
  import TimestampPicker from "#lib/components/chat/TimestampPicker.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import { uploadAttachment } from "#lib/chat/chat-attachments";
  import { maxChatHtmlLength, maxChatTextLength, sanitizeChatHtml } from "#lib/chat/rich-chat";
  import { collectMentions, MentionNode, mentionCandidates, mentionQuery, parseMention, type MentionCandidate } from "#lib/chat/mentions";
  import { getWorkspace } from "#lib/workspace";

  type DirectComposer = { busy: boolean; maxBytes: number; send: (text: string, html?: string) => Promise<boolean> };
  type ReplyDraft = { id: string; name: string; text: string };
  let { channelId, channelName, direct, enabled, disabledHint = "Join a channel to send a message", replyTo, oncancelreply }: {
    enabled: boolean;
    /** Placeholder shown while sending is unavailable. */
    disabledHint?: string;
    /** The channel message this draft answers. */
    replyTo?: ReplyDraft;
    oncancelreply?: () => void;
  } & (
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
  const channel = $derived(direct ? undefined : workspace.view.snapshot?.channels.find(({ id }) => id === channelId));
  const attaching = $derived(!direct && workspace.maxAttachmentBytes > 0 &&
    (channel?.canAttachFiles ?? workspace.view.snapshot?.canAttachFiles) !== false);
  const busy = $derived(direct ? direct.busy : Boolean(workspace.pending));
  const rich = $derived(Boolean(direct) || workspace.richChat);
  const label = $derived(direct ? "Encrypted message" : "Channel message");
  const sendLabel = $derived(direct ? "Send direct message" : "Send message");
  const placeholder = $derived(direct ? "Write a direct message"
    : enabled ? `Message #${channelName}` : disabledHint);
  const textLimit = $derived(direct?.maxBytes ?? maxChatTextLength);
  const draftTooLong = $derived(message.length > textLimit);
  // An `@` query at the caret: `from`/`to` span the `@` and the typed text, in editor positions or input offsets.
  let mention = $state<{ query: string; from: number; to: number } | null>(null);
  let activeCandidate = $state(0);
  /** Mentions inserted into the plain-text input, kept while their `@label` is still in the text. */
  let plainMentions: MentionCandidate[] = [];
  const candidates = $derived(!direct && mention && enabled && !busy
    ? mentionCandidates(workspace.view.snapshot, workspace.view.messages.filter((entry) => entry.channelId === channelId), mention.query) : []);
  const selectedCandidate = $derived(activeCandidate < candidates.length ? activeCandidate : 0);
  const extensions = [
    StarterKit.configure({ heading: false, horizontalRule: false, trailingNode: false,
      link: { openOnClick: false, defaultProtocol: "https" } }),
    Placeholder.configure({ placeholder: () => placeholder, showOnlyWhenEditable: false }),
    MentionNode,
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

  function trackEditorMention(draft: Editor) {
    const { selection } = draft.state;
    if (direct || !selection.empty) { mention = null; return; }
    const caret = selection.$from;
    const query = mentionQuery(caret.parent.textBetween(0, caret.parentOffset, undefined, "\ufffc"));
    if (query !== mention?.query) activeCandidate = 0;
    mention = query === undefined ? null : { query, from: selection.from - query.length - 1, to: selection.from };
  }

  function trackInputMention() {
    const caret = field?.selectionStart ?? message.length;
    const query = direct ? undefined : mentionQuery(message.slice(0, caret));
    if (query !== mention?.query) activeCandidate = 0;
    mention = query === undefined ? null : { query, from: caret - query.length - 1, to: caret };
  }

  async function pickMention(candidate: MentionCandidate) {
    const range = mention;
    mention = null;
    if (!range) return;
    if (editor) {
      editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, [
        { type: "mention", attrs: { mention: `${candidate.kind}:${candidate.target}`, label: candidate.label } },
        { type: "text", text: " " },
      ]).run();
      return;
    }
    const inserted = `@${candidate.label} `;
    const next = message.slice(0, range.from) + inserted + message.slice(range.to);
    if (next.length > maxChatTextLength) return;
    message = next;
    plainMentions = [...plainMentions, candidate];
    await tick();
    field?.focus();
    field?.setSelectionRange(range.from + inserted.length, range.from + inserted.length);
  }

  /** Handles suggestion navigation; returns true when the key was used. */
  function mentionKeys(event: KeyboardEvent) {
    if (event.key === "Escape" && !candidates.length && replyTo) {
      oncancelreply?.();
      return true;
    }
    if (!candidates.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      activeCandidate = (selectedCandidate + step + candidates.length) % candidates.length;
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
      void pickMention(candidates[selectedCandidate]!);
      return true;
    }
    if (event.key === "Escape") {
      mention = null;
      return true;
    }
    return false;
  }

  function draftMentions() {
    if (editor) {
      const picked: { kind: "account" | "role"; target: string }[] = [];
      editor.state.doc.descendants((node) => {
        const parsed = node.type.name === "mention" ? parseMention(node.attrs.mention as string) : undefined;
        if (parsed) picked.push(parsed);
      });
      return collectMentions(picked);
    }
    return collectMentions(plainMentions.filter(({ label }) => message.includes(`@${label}`)));
  }

  function configureEditor({ editor: draft }: { editor: Editor }) {
    draft.on("selectionUpdate", () => trackEditorMention(draft));
    draft.setOptions({ editorProps: {
      attributes: { "aria-label": label, "aria-multiline": "true", role: "textbox" },
      transformPastedHTML: sanitizeChatHtml,
      handleKeyDown(view, event) {
        if (draft.isEditable && mentionKeys(event)) { event.preventDefault(); return true; }
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

  async function insertText(text: string) {
    if (!enabled || busy) return;
    if (editor) {
      editor.chain().focus().insertContent({ type: "text", text }).run();
      return;
    }
    const start = field?.selectionStart ?? message.length;
    const end = field?.selectionEnd ?? start;
    const next = message.slice(0, start) + text + message.slice(end);
    if (next.length > maxChatTextLength) return;
    message = next;
    await tick();
    field?.focus();
    field?.setSelectionRange(start + text.length, start + text.length);
  }

  async function insertEmoji(emoji: string) {
    pickerOpen = false;
    await insertText(emoji);
  }

  function insertTimestamp(token: string) {
    // Pad with spaces so the token never merges into a neighbouring word.
    const before = editor ? editor.state.doc.textBetween(Math.max(0, editor.state.selection.from - 1), editor.state.selection.from)
      : message.slice(0, field?.selectionStart ?? message.length).slice(-1);
    void insertText(`${before && !/\s/.test(before) ? " " : ""}${token} `);
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
    if (!snapshot || !channelId) return;
    const attachment = file;
    if (attachment && !attaching) {
      workspace.actionError = "Remove the attachment to send this message. Your role cannot upload files in this channel.";
      return;
    }
    if (attachment && !validAttachment(attachment)) return;
    const mentions = draftMentions();
    const reply = replyTo?.id;
    const payload = { channelId, text, html, ...(reply ? { replyTo: reply } : {}), ...(mentions ? { mentions } : {}) };
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
      ? await workspace.runAction("message", () => uploadAttachment(origin, snapshot.connectionId, channelId, text, attachment, html,
        { replyTo: reply, mentions }))
      : await workspace.run("message", "send_message", payload);
    if (sent) {
      editor?.commands.clearContent();
      message = "";
      file = undefined;
      plainMentions = [];
      mention = null;
      if (reply) oncancelreply?.();
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
  <EmojiPicker bind:open={pickerOpen} disabled={!enabled || busy} onpick={(emoji) => void insertEmoji(emoji)}
    triggerClass={buttonVariants({ variant: "outline", size: "icon", class: "icon-button" })}>
    <Smile size={17} />
  </EmojiPicker>
  <TimestampPicker disabled={!enabled || busy} oninsert={insertTimestamp}
    triggerClass={buttonVariants({ variant: "outline", size: "icon", class: "icon-button" })} />
  <Button type="submit" class="send-button" variant="default" aria-label={sendLabel} title={sendLabel}
    disabled={!enabled || (!message.trim() && !file) || busy || draftTooLong}>
    <Send size={17} />
  </Button>
{/snippet}

<form class="composer" class:formatted={rich} class:replying={Boolean(replyTo)} onsubmit={send} ondragover={dragOver} ondrop={dropFile}>
  {#if replyTo}
    <div class="reply-draft" role="status">
      <CornerUpLeft size={14} aria-hidden="true" />
      <span class="reply-draft-label">
        <span class="reply-draft-heading">Replying to <strong>{replyTo.name}</strong></span>
        {#if replyTo.text}<span class="reply-draft-text">{replyTo.text}</span>{/if}
      </span>
      <button type="button" class="reply-draft-cancel" aria-label="Cancel reply" title="Cancel reply (Esc)" disabled={busy}
        onclick={() => oncancelreply?.()}><X size={14} aria-hidden="true" /></button>
    </div>
  {/if}
  {#if candidates.length}
    <ul class="mention-suggestions" role="listbox" aria-label="Mention suggestions">
      {#each candidates as candidate, index (candidate.kind + candidate.target)}
        <li role="option" aria-selected={index === selectedCandidate}>
          <button type="button" tabindex="-1" onmousedown={(event) => event.preventDefault()} onclick={() => void pickMention(candidate)}
            onmouseenter={() => { activeCandidate = index; }}>
            {#if candidate.kind === "role"}<Users size={14} aria-hidden="true" />{:else}<AtSign size={14} aria-hidden="true" />{/if}
            <span class="truncate">{candidate.label}</span>
            {#if candidate.kind === "role"}<span class="mention-kind">Role</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
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
          trackEditorMention(draft);
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
      bind:ref={field} bind:value={message} oninput={trackInputMention} onclick={trackInputMention}
      onkeyup={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") trackInputMention(); }}
      onkeydown={(event) => { if (mentionKeys(event)) event.preventDefault(); }} onblur={() => { mention = null; }} />
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
  .attachment-draft, .reply-draft { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
  .reply-draft {
    min-width: 0;
    padding: .35rem .35rem .35rem .65rem;
    border: 1px solid var(--border);
    border-inline-start: 3px solid var(--primary);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--primary) 7%, var(--background));
    color: var(--muted-foreground);
    font-size: var(--type-caption);
  }
  /* In the rich editor the strip sits on top of the editor as one control. */
  .composer.formatted.replying .reply-draft { margin-bottom: -8px; border-bottom: 0; border-end-start-radius: 0; border-end-end-radius: 0; }
  .composer.formatted.replying .rich-editor { border-start-start-radius: 0; border-start-end-radius: 0; }
  .reply-draft :global(svg) { flex: none; }
  .reply-draft > :global(svg) { color: var(--primary); }
  .reply-draft-label { display: flex; flex: 1; align-items: baseline; gap: 8px; min-width: 0; }
  .reply-draft-heading { flex: none; }
  .reply-draft-heading strong { color: var(--foreground); font-weight: 600; }
  .reply-draft-text { min-width: 0; overflow: hidden; color: color-mix(in srgb, var(--foreground) 65%, transparent); text-overflow: ellipsis; white-space: nowrap; }
  .reply-draft-cancel {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    color: var(--muted-foreground);
  }
  .reply-draft-cancel:not(:disabled):hover { background: var(--control-hover); color: var(--foreground); }
  .reply-draft-cancel:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
  .composer { position: relative; }
  .mention-suggestions {
    position: absolute;
    inset-inline: 0;
    bottom: calc(100% + 4px);
    z-index: 20;
    display: grid;
    max-height: 16rem;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow: 0 8px 24px rgb(0 0 0 / .18);
  }
  .mention-suggestions button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: var(--radius-sm); text-align: start; }
  .mention-suggestions [aria-selected="true"] button { background: var(--control-selected); }
  .mention-kind { margin-inline-start: auto; color: var(--muted-foreground); font-size: var(--type-small); }
  .rich-editor :global(.tiptap [data-mention]) { padding: 0 .2em; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--primary) 18%, transparent); color: var(--primary); font-weight: 600; }
  .attachment-draft :global(svg) { flex: none; }
</style>
