import { createContext } from "svelte";

export interface ChatDisplay {
  density: "comfortable" | "compact";
  showAvatars: boolean;
  showTimestamps: boolean;
  groupMessages: boolean;
}

export const defaultChatDisplay: Readonly<ChatDisplay> = {
  density: "comfortable",
  showAvatars: true,
  showTimestamps: true,
  groupMessages: false,
};

const storageKey = "korero:chat-display";

export function readChatDisplay(): ChatDisplay {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<ChatDisplay> | null;
    return {
      density: saved?.density === "compact" ? "compact" : defaultChatDisplay.density,
      showAvatars: typeof saved?.showAvatars === "boolean" ? saved.showAvatars : defaultChatDisplay.showAvatars,
      showTimestamps: typeof saved?.showTimestamps === "boolean" ? saved.showTimestamps : defaultChatDisplay.showTimestamps,
      groupMessages: typeof saved?.groupMessages === "boolean" ? saved.groupMessages : defaultChatDisplay.groupMessages,
    };
  } catch {
    return { ...defaultChatDisplay };
  }
}

export function saveChatDisplay(value: ChatDisplay): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const [getChatDisplay, setChatDisplay] = createContext<{
  readonly value: Readonly<ChatDisplay>;
  update(value: ChatDisplay): boolean;
}>();
