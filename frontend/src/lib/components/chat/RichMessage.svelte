<script lang="ts">
  import { chatLinkUrl, sanitizeChatMarkup } from "#lib/chat/rich-chat";
  import { hasTimestamps, refreshRelativeTimestamps, renderTimestamps } from "#lib/chat/chat-timestamps";
  import { parseMention, type MentionKind } from "#lib/chat/mentions";

  let { text, html, onlink, mention }: {
    text: string;
    html?: string;
    onlink?: (url: string) => void;
    /** Resolves a mention pill's current label and whether it refers to the reader. */
    mention?: (kind: MentionKind, target: string) => { label?: string; me: boolean };
  } = $props();
  const formatted = $derived(html ? sanitizeChatMarkup(html) : undefined);
  const timestamps = $derived(hasTimestamps(text));

  function addTextLinks(fragment: DocumentFragment) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest("a, code, pre")) nodes.push(node);
    }
    for (const node of nodes) {
      const parts = node.data.split(/(\b(?:https?:\/\/|www\.)[^\s<>"']+)/gi);
      if (parts.length === 1) continue;
      const replacement = document.createDocumentFragment();
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (index % 2 === 0) {
          replacement.append(part);
          continue;
        }
        let label = part.replace(/[.,!?;:]+$/, "");
        for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
          if (label.endsWith(close) && !label.includes(open)) label = label.slice(0, -1);
        }
        const destination = chatLinkUrl(/^www\./i.test(label) ? `https://${label}` : label);
        if (!destination) {
          replacement.append(part);
          continue;
        }
        const link = document.createElement("a");
        link.href = destination;
        link.textContent = label;
        replacement.append(link, part.slice(label.length));
      }
      node.replaceWith(replacement);
    }
  }

  function renderMessage(element: HTMLElement) {
    const fragment = formatted ? formatted.cloneNode(true) as DocumentFragment : document.createDocumentFragment();
    if (!formatted) fragment.append(text);
    renderTimestamps(fragment);
    for (const pill of fragment.querySelectorAll<HTMLElement>("span[data-mention]")) {
      const parsed = parseMention(pill.dataset.mention);
      const resolved = parsed && mention?.(parsed.kind, parsed.target);
      if (resolved?.label) pill.textContent = `@${resolved.label}`;
      pill.classList.add("chat-mention");
      if (resolved?.me) pill.classList.add("mine");
    }
    const confirm = onlink;
    if (confirm) {
      addTextLinks(fragment);
      for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const destination = link.href;
        // Keep the destination out of href so alternate click actions also require confirmation.
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "link");
        button.append(...link.childNodes);
        button.addEventListener("click", () => confirm(destination));
        link.replaceWith(button);
      }
    }
    element.replaceChildren(fragment);
    return refreshRelativeTimestamps(element);
  }
</script>

{#if formatted}
  <div class="rich-message" {@attach renderMessage}></div>
{:else if (onlink || timestamps) && text}
  <p class="rich-message" {@attach renderMessage}></p>
{:else if text}
  <p>{text}</p>
{/if}

<style>
  .rich-message { overflow-wrap: anywhere; }
  .rich-message > :global(* + *) { margin-block-start: .35em; }
  .rich-message :global(a), .rich-message :global(button[role="link"]) { color: var(--primary); text-decoration: underline; }
  .rich-message :global(button[role="link"]) { display: inline; text-align: inherit; overflow-wrap: anywhere; }
  .rich-message :global(blockquote) { border-inline-start: 2px solid var(--border); padding-inline-start: .65em; }
  .rich-message :global(ul), .rich-message :global(ol) { padding-inline-start: 1.45em; }
  .rich-message :global(ul) { list-style: disc; }
  .rich-message :global(ol) { list-style: decimal; }
  .rich-message :global(code), .rich-message :global(pre) { background: var(--background); border-radius: var(--radius-sm); }
  .rich-message :global(code) { padding: .12em .3em; }
  .rich-message :global(pre) { overflow-x: auto; padding: .5em .65em; }
  .rich-message :global(pre code) { padding: 0; }
  .rich-message :global(.chat-mention) { padding: 0 .2em; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--primary) 18%, transparent); color: var(--primary); font-weight: 600; }
  .rich-message :global(.chat-mention.mine) { background: color-mix(in srgb, var(--primary) 32%, transparent); color: var(--foreground); }
  .rich-message :global(.chat-timestamp) { padding: .05em .3em; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--primary) 16%, transparent); color: var(--foreground); cursor: help; white-space: nowrap; }
</style>
