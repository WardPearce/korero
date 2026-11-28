import type { KoreroClient } from "./session.js";
import type { ChannelData, Message, MessageMentions, PinCursor, SearchCursor } from "./types.js";

export interface MessageBody {
  text: string;
  html?: string;
  /** Accounts and mentionable roles the message mentions. */
  mentions?: Partial<MessageMentions>;
}
export type MessageContent = string | MessageBody;
/** `replyTo` is the ID of a message in the same channel. */
export type SendContent = string | (MessageBody & { replyTo?: string });
const body = <T extends MessageBody>(value: string | T): T | MessageBody => typeof value === "string" ? { text: value } : value;

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

  send(value: SendContent) {
    const { text, html, mentions, replyTo } = body(value) as MessageBody & { replyTo?: string };
    return this.client.sendMessage(this.id, text, html, { mentions, replyTo });
  }

  history(before?: number) {
    return this.client.rpc<Message[]>("message.history", { channelId: this.id, before })
      .then((messages) => messages.map((message) => new ChannelMessage(message, this, this.client)));
  }

  pins(before?: PinCursor) {
    return this.client.pinnedMessages(this.id, before);
  }

  search(query: string, before?: SearchCursor) {
    return this.client.searchMessages(this.id, query, before);
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
  get senderName() { return this.data.senderName; }

  /** Passing `mentions` replaces the message's mentions; omitting it keeps them. */
  edit(value: MessageContent) {
    const { text, html, mentions } = body(value);
    return this.client.editMessage(this.id, text, html, mentions);
  }

  reply(value: MessageContent) {
    return this.channel.send({ ...body(value), replyTo: this.id });
  }

  react(emoji: string, reacted = true) {
    return this.client.reactToMessage(this.channel.id, this.id, emoji, reacted);
  }

  delete() {
    return this.client.deleteMessage(this.id);
  }

  setPinned(pinned: boolean) {
    return this.client.setMessagePin(this.channel.id, this.id, pinned);
  }
}
