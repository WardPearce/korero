import { apiFor, requestError, type Message } from "../connection/client";

export async function uploadAttachment(origin: string, connectionId: string, channelId: string, text: string, file: File, html?: string) {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const result = await apiFor(origin).chat.attachments.post({
    connectionId, channelId, text, html, name: file.name, data,
  });
  if (result.error) throw requestError(result.error);
}

export async function downloadAttachment(origin: string, connectionId: string, message: Message) {
  if (!message.attachment) return;
  const result = await apiFor(origin).chat.attachments({ messageId: message.id }).get({ query: { connectionId } });
  if (result.error) throw requestError(result.error);
  if (!result.data || !("data" in result.data)) throw new Error("The server returned an invalid attachment.");
  const binary = atob(result.data.data);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset++) {
    bytes[offset] = binary.charCodeAt(offset);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = message.attachment.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
