import { KoreroClient, serverOrigin, type DirectOperation, type SessionMediaAdapter, type VoiceState } from "korero-chat/source";
import { MobileCallAudio } from "../media/mobile-call-audio";
import { WebVoice } from "../media/web-voice";
import { mobileApp, voiceApp } from "./platform";
import { openServerSocket, serverFetch } from "./transport";

export { serverOrigin as browserServerOrigin };

const callAudio = new MobileCallAudio();

function mobileMedia(): SessionMediaAdapter {
  let audio: AudioContext | undefined;
  return {
    resume() {
      void (audio ??= new AudioContext()).resume().catch(() => {});
    },
    open(channelId, connectionId, request, onChange, volumes) {
      return new WebVoice(channelId, connectionId, audio ??= new AudioContext(), callAudio, request, onChange, volumes);
    },
    stop() {
      void callAudio.setMode("auto").catch(() => {});
      void audio?.close().catch(() => {});
      audio = undefined;
    },
  };
}

/**
 * Holds a session for each signed-in server. Requests that name a connection go to
 * the session that owns it. Others name the server origin.
 */
class BrowserSessions {
  private readonly sessions = new Map<string, KoreroClient>();
  private update: (origin: string, view: VoiceState) => void = () => {};

  watch(update: (origin: string, view: VoiceState) => void) {
    this.update = update;
    const visibility = () => {
      if (!document.hidden) for (const session of this.sessions.values()) session.resumeAudio();
    };
    if (mobileApp()) document.addEventListener("visibilitychange", visibility);
    return () => {
      this.update = () => {};
      if (mobileApp()) document.removeEventListener("visibilitychange", visibility);
    };
  }

  /** Replaces any session for this origin with a fresh, signed-out one. */
  async select(origin: string) {
    await this.disconnect(origin);
    const session = new KoreroClient(origin, { transport: { fetch: serverFetch, openSocket: openServerSocket },
      media: mobileApp() && voiceApp() ? mobileMedia() : undefined });
    session.on("state", (view) => {
      if (this.sessions.get(origin) === session) this.update(origin, view);
    });
    this.sessions.set(origin, session);
    return session;
  }

  session(origin: string) {
    const session = this.sessions.get(origin);
    if (!session) throw new Error("Connect to a server first.");
    return session;
  }

  private connection(connectionId: string) {
    for (const session of this.sessions.values()) if (session.connectionId === connectionId) return session;
    throw new Error("The server connection changed.");
  }

  fetch(request: Request) {
    const origin = new URL(request.url).origin;
    const session = this.sessions.get(origin);
    if (session) return session.fetch(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/server/info" || path === "/api/v1/server/capabilities") {
      return serverFetch(request, { timeout: 8000 });
    }
    throw new Error("The selected server changed.");
  }

  directRequest<T>(connectionId: string, kind: DirectOperation, payload: unknown) {
    try { return this.connection(connectionId).directRequest<T>(connectionId, kind, payload); }
    catch (error) { return Promise.reject(error); }
  }

  screenRequest<T>(connectionId: string, channelId: string, kind: string, payload: unknown) {
    try { return this.connection(connectionId).screenRequest<T>(connectionId, channelId, kind, payload); }
    catch (error) { return Promise.reject(error); }
  }

  /** Voice uses one call at a time, so joining a channel leaves any channel on another server. */
  async joinChannel(origin: string, channelId: string, password?: string) {
    const session = this.session(origin);
    for (const other of this.sessions.values()) {
      if (other !== session && other.channelId) await other.leaveChannel();
    }
    await session.channel(channelId).join(password);
  }

  async disconnect(origin: string) {
    const session = this.sessions.get(origin);
    this.sessions.delete(origin);
    await session?.disconnect();
  }
}

export const browserSessions = new BrowserSessions();
