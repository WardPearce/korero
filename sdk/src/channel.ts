import type { KoreroClient } from "./session.js";
import type { ChannelData, Message, PinCursor } from "./types.js";

export type MessageContent = string | { text: string; html?: string };

export interface ChannelOptions {
  name?: string;
  description?: string;
  parentId?: string | null;
  position?: number;
  capacity?: number | null;
  password?: string | null;
  backgroundImageUrl?: string | null;
  icon?: string | null;
  audioBitrate?: number | null;
}

/** A channel on a particular signed-in client. */
export class Channel {
  constructor(readonly id: string, private readonly client: KoreroClient) {}

  get data(): ChannelData | undefined {
    return this.client.state.snapshot?.channels.find(({ id }) => id === this.id);
  }

  send(content: MessageContent) {
    const { text, html } = typeof content === "string" ? { text: content } : content;
    return this.client.sendMessage(this.id, text, html);
  }

  history(before?: number) {
    return this.client.rpc<Message[]>("message.history", { channelId: this.id, before })
      .then((messages) => messages.map((message) => new ChannelMessage(message, this, this.client)));
  }

  pins(before?: PinCursor) {
    return this.client.pinnedMessages(this.id, before);
  }

  async follow() {
    const connectionId = this.client.connectionId;
    if (!connectionId) throw new Error("Connect to a server first.");
    await this.client.viewChannel(connectionId, this.id);
  }

  join(password?: string) {
    return this.client.joinChannel(this.id, password);
  }

  edit(changes: ChannelOptions) {
    return this.client.saveChannel({ ...changes, channelId: this.id });
  }

  delete() {
    return this.client.deleteChannel(this.id);
  }
}

/** A channel message and the operations available on it. */
export class ChannelMessage {
  constructor(readonly data: Message, readonly channel: Channel, private readonly client: KoreroClient) {}

  get id() { return this.data.id; }
  get text() { return this.data.text; }
  get senderId() { return this.data.senderId; }

  edit(content: MessageContent) {
    const { text, html } = typeof content === "string" ? { text: content } : content;
    return this.client.editMessage(this.id, text, html);
  }

  delete() {
    return this.client.deleteMessage(this.id);
  }

  setPinned(pinned: boolean) {
    return this.client.setMessagePin(this.channel.id, this.id, pinned);
  }
}
