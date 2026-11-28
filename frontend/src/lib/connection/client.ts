import { createApi, type DirectOperation, type Message, type PinCursor, type PinnedMessagePage, type RelayResponse, type VoiceState } from "korero-chat/source";
import { browserSessions } from "./browser-session";
import { call, desktopApp, watchDesktop } from "./platform";

export {
  isSameDirectMessage, messageFrom, offline, requestError,
  type Account, type ChannelData as Channel, type DirectMessage, type DirectMessageChange,
  type DirectMessageReference, type Member, type MemberRequest, type Message, type PinCursor, type PinnedMessagePage, type Poke,
  type RelayResponse, type ScreenShare, type ServerInfo, type Snapshot, type VoiceState,
} from "korero-chat/source";
export { call, desktopApp } from "./platform";

export function directRequest<T>(connectionId: string, kind: DirectOperation, payload: unknown = {}) {
  return desktopApp()
    ? call<T>("direct_request", { connectionId, kind, payload })
    : browserSessions.directRequest<T>(connectionId, kind, payload);
}

export async function channelPins(origin: string, connectionId: string, channelId: string, before?: PinCursor) {
  if (desktopApp()) return call<PinnedMessagePage>("message_pins", { origin, connectionId, channelId, before });
  const session = browserSessions.session(origin);
  if (session.connectionId !== connectionId) throw new Error("The server connection changed.");
  return session.pinnedMessages(channelId, before);
}

export async function channelMessageContext(origin: string, connectionId: string, channelId: string, messageId: string) {
  if (desktopApp()) return call<Message[]>("message_context", { origin, connectionId, channelId, messageId });
  const session = browserSessions.session(origin);
  if (session.connectionId !== connectionId) throw new Error("The server connection changed.");
  return session.messageContext(channelId, messageId);
}

/** Starts the signed-in session for a server prepared with `browserSessions.select` or `prepare_server`. */
export function startSession(origin: string, memberVolumes: Record<string, number>) {
  return desktopApp() ? call("start_session", { origin }) : browserSessions.session(origin).start(memberVolumes);
}

export type DesktopSessionState = Omit<VoiceState, "voice" | "voiceError" | "whisperChannelId">;

export function watchDesktopSession(onState: (state: DesktopSessionState) => void) {
  return watchDesktop<DesktopSessionState>("korero:state", onState);
}

export function apiFor(origin: string) {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!desktopApp()) return browserSessions.fetch(request);
    const url = new URL(request.url);
    const body = request.body ? (await request.json() as unknown) : null;
    const result = await call<RelayResponse>("api_fetch", {
      origin: url.origin,
      method: request.method,
      path: url.pathname + url.search,
      body,
    });
    if ([204, 205, 304].includes(result.status)) {
      return new Response(null, { status: result.status });
    }
    return Response.json(result.body, { status: result.status });
  };
  return createApi(origin, fetcher);
}

export function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
}

export function shortHost(origin: string) {
  return origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export const messageTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
