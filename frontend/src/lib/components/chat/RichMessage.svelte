<script lang="ts">
  import { sanitizeChatMarkup } from "#lib/chat/rich-chat";
  import { hasTimestamps, refreshRelativeTimestamps, renderTimestamps } from "#lib/chat/chat-timestamps";

  let { text, html, onlink }: { text: string; html?: string; onlink?: (url: string) => void } = $props();
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
        const link = document.createElement("a");
        link.href = /^www\./i.test(label) ? `https://${label}` : label;
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
    const confirm = onlink;
    if (confirm) {
      addTextLinks(fragment);
      for (const link of fragment.querySelectorAll("a[href]")) {
        let destination: string;
        try {
          const url = new URL(link.getAttribute("href") ?? "");
          if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported link");
          destination = url.href;
        } catch {
          link.removeAttribute("href");
          continue;
        }
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
  .rich-message :global(.chat-timestamp) { padding: .05em .3em; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--primary) 16%, transparent); color: var(--foreground); cursor: help; white-space: nowrap; }
</style>
