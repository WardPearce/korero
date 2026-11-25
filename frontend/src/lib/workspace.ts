import { createContext } from "svelte";
import type { MemberRequest, VoiceState } from "./client";

export type MobilePane = "servers" | "channels" | "room";

interface Workspace {
  readonly view: VoiceState;
  readonly serverOrigin: string;
  readonly serverTitle: string;
  readonly bannerImageUrl: string | null;
  readonly channelBackgrounds: boolean;
  readonly channelWidth: number;
  readonly channelMax: number;
  resizeChannel(value: number, commit: boolean): void;
  readonly pending: string;
  actionError: string;
  selectedChannelId: string | null;
  mobilePane: MobilePane;
  showConnect(address?: string): void;
  run(action: string, command: string, args?: Record<string, unknown>): Promise<boolean>;
  memberAction(request: MemberRequest): Promise<boolean>;
  memberVolume(accountId: string): number;
  setMemberVolume(accountId: string, level: number): Promise<boolean>;
  reorderChannel(channelId: string, targetId: string, placement: "before" | "after"): Promise<boolean>;
  disconnect(): Promise<boolean>;
}

export const [getWorkspace, setWorkspace] = createContext<Workspace>();
