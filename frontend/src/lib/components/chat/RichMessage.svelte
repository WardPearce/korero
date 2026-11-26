<script lang="ts">
  import { sanitizeChatMarkup } from "#lib/chat/rich-chat";

  let { text, html }: { text: string; html?: string } = $props();
  const formatted = $derived(html ? sanitizeChatMarkup(html) : undefined);
</script>

{#if formatted}
  <div class="rich-message" {@attach (element) => {
    if (formatted) element.replaceChildren(formatted.cloneNode(true));
  }}></div>
{:else if text}
  <p>{text}</p>
{/if}

<style>
  .rich-message { overflow-wrap: anywhere; }
  .rich-message > :global(* + *) { margin-block-start: .35em; }
  .rich-message :global(a) { color: var(--primary); text-decoration: underline; }
  .rich-message :global(blockquote) { border-inline-start: 2px solid var(--border); padding-inline-start: .65em; }
  .rich-message :global(ul), .rich-message :global(ol) { padding-inline-start: 1.45em; }
  .rich-message :global(ul) { list-style: disc; }
  .rich-message :global(ol) { list-style: decimal; }
  .rich-message :global(code), .rich-message :global(pre) { background: var(--background); border-radius: var(--radius-sm); }
  .rich-message :global(code) { padding: .12em .3em; }
  .rich-message :global(pre) { overflow-x: auto; padding: .5em .65em; }
  .rich-message :global(pre code) { padding: 0; }
</style>
