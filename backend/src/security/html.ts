// Server-side mirror of the client's DOMPurify allowlist (frontend/src/lib/chat/rich-chat.ts).
// Clients still sanitize on render; this keeps stored and relayed markup safe for any client.
const allowedTags = new Set(["p", "br", "strong", "b", "em", "i", "u", "s", "del", "code", "pre",
  "blockquote", "ul", "ol", "li", "a"]);
// Elements whose content is never shown as chat text.
const droppedTags = new Set(["script", "style", "template", "iframe", "frame", "frameset", "object", "embed", "noscript",
  "noembed", "noframes", "textarea", "title", "xmp", "plaintext", "svg", "math", "select", "head", "link", "meta", "base"]);
const escapeText = (text: string) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;");

const rewriter = new HTMLRewriter()
  .on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();
      if (droppedTags.has(tag)) { element.remove(); return; }
      if (!allowedTags.has(tag)) { element.removeAndKeepContent(); return; }
      for (const [name, value] of [...element.attributes]) {
        const keep = (tag === "a" && name === "href" && /^https?:\/\//i.test(value.trim())) ||
          (tag === "ol" && name === "start" && /^\d{1,6}$/.test(value.trim()));
        if (!keep) element.removeAttribute(name);
      }
    },
    comments(comment) { comment.remove(); },
  })
  .onDocument({
    // Removing a tag must not let surrounding text form a new one, as in `<<x>script>`.
    text(text) { if (text.text) text.replace(escapeText(text.text), { html: true }); },
    comments(comment) { comment.remove(); },
    doctype() {},
  });

/** Returns allowlisted chat markup, or null when nothing visible remains. */
export function sanitizeChatHtml(html: string): string | null {
  const clean = rewriter.transform(html);
  const visible = new HTMLRewriter().on("*", { element(element) { element.removeAndKeepContent(); } }).transform(clean);
  return visible.replace(/&nbsp;|&#160;|&#xa0;/gi, " ").trim() ? clean : null;
}
