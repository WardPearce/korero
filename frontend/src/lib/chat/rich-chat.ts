import DOMPurify from "dompurify";

export const maxChatTextLength = 2000;
export const maxChatHtmlLength = 32768;

const httpUrl = /^https?:\/\//i;
const mentionAttribute = /^(account|role):(?=.*\S)[^\u0000-\u001f\u007f/]{1,80}$/;

export function chatLinkUrl(value: string) {
  const candidate = value.trim();
  if (!httpUrl.test(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeChatMarkup(html: string) {
  if (!DOMPurify.isSupported || html.length > maxChatHtmlLength) return undefined;
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "del", "code", "pre",
      "blockquote", "ul", "ol", "li", "a", "span"],
    ALLOWED_ATTR: ["href", "start", "data-mention"],
    ALLOWED_URI_REGEXP: httpUrl,
    // Values are checked against `mentionAttribute` below rather than as URLs.
    ADD_URI_SAFE_ATTR: ["data-mention"],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  if (!fragment.textContent?.trim()) return undefined;
  // Mirrors the server: only spans may carry a mention, and only in the `kind:target` form.
  for (const element of fragment.querySelectorAll("[data-mention]")) {
    if (element.localName !== "span" || !mentionAttribute.test(element.getAttribute("data-mention") ?? "")) element.removeAttribute("data-mention");
  }
  for (const link of fragment.querySelectorAll("[href]")) {
    const destination = link.localName === "a" ? chatLinkUrl(link.getAttribute("href") ?? "") : undefined;
    if (!destination) {
      link.removeAttribute("href");
      continue;
    }
    link.setAttribute("href", destination);
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
