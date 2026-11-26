import DOMPurify from "dompurify";

export const maxChatTextLength = 2000;
export const maxChatHtmlLength = 32768;

export function sanitizeChatMarkup(html: string) {
  if (!DOMPurify.isSupported || html.length > maxChatHtmlLength) return undefined;
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "del", "code", "pre",
      "blockquote", "ul", "ol", "li", "a"],
    ALLOWED_ATTR: ["href", "start"],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  if (!fragment.textContent?.trim()) return undefined;
  for (const link of fragment.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return fragment;
}

export function sanitizeChatHtml(html: string) {
  const markup = sanitizeChatMarkup(html);
  if (!markup) return "";
  const container = document.createElement("div");
  container.append(markup);
  return container.innerHTML;
}
