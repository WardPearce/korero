import { apiFor, requestError } from "../connection/client";

const pictureSize = 192;
const maxUploadBytes = 10 * 1024 * 1024;
const maxEncodedLength = 256 * 1024;
const cacheSize = 128;
const cacheLifetimeMs = 5 * 60_000;
const pngPrefix = "data:image/png;base64,";

export async function encodeProfilePicture(file: File) {
  if (file.size > maxUploadBytes) throw new Error("Choose an image smaller than 10 MiB.");
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("Choose a readable PNG, JPEG, or WebP image.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = pictureSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This device could not prepare the image.");
    const side = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, pictureSize, pictureSize);
    return canvas.toDataURL("image/png").slice(pngPrefix.length);
  } finally {
    image.close();
  }
}

export async function updateProfilePicture(origin: string, data: string | null) {
  const result = await apiFor(origin).account.picture.patch({ data });
  if (result.error) throw requestError(result.error);
}

export function createProfilePictureCache() {
  type CachedPicture = { avatarId?: string | null; expires: number; source: Promise<string | undefined> };
  const cache = new Map<string, CachedPicture>();
  let session = "";

  return (origin: string, connectionId: string, accountId: string, avatarId?: string | null) => {
    const current = origin + "/" + connectionId;
    if (current !== session) {
      cache.clear();
      session = current;
    }
    const existing = cache.get(accountId);
    if (existing && (avatarId === undefined ? existing.expires > Date.now() : avatarId === existing.avatarId)) {
      cache.delete(accountId);
      cache.set(accountId, existing);
      return existing.source;
    }
    const entry: CachedPicture = { avatarId, expires: Date.now() + cacheLifetimeMs, source: Promise.resolve(undefined) };
    if (avatarId !== null) {
      entry.source = Promise.resolve(apiFor(origin).account.picture({ accountId }).get()).then(({ data, error }) => {
        if (error || !data || !("avatarId" in data)) throw requestError(error);
        entry.avatarId = data.avatarId;
        if (typeof data.data === "string" && data.data.length <= maxEncodedLength) return pngPrefix + data.data;
        return undefined;
      }).catch(() => {
        if (cache.get(accountId) === entry) cache.delete(accountId);
        return undefined;
      });
    }
    cache.delete(accountId);
    cache.set(accountId, entry);
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return entry.source;
  };
}
