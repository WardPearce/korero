import { apiFor, requestError } from "../connection/client";

const pictureSize = 192;
const maxUploadBytes = 10 * 1024 * 1024;
const maxEncodedLength = 256 * 1024;
const cacheSize = 128;
const cacheLifetimeMs = 5 * 60_000;
const failureRetryMs = 30_000;
const pngPrefix = "data:image/png;base64,";

export async function encodeProfilePicture(file: File) {
  if (file.size > maxUploadBytes) throw new Error("Choose an image smaller than 10 MiB.");
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Choose a readable PNG, JPEG, or WebP image.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = pictureSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This device could not prepare the image.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const side = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, pictureSize, pictureSize);
    return canvas.toDataURL("image/png").slice(pngPrefix.length);
  } finally {
    image.close();
  }
}

export async function updateProfilePicture(origin: string, data: string | null) {
  const result = await apiFor(origin).account.picture.patch({ data });
  if (result.error || !result.data || !("avatarId" in result.data)) throw requestError(result.error);
  return result.data.avatarId;
}

type CachedPicture = { avatarId?: string | null; expires: number; failed?: boolean; source: Promise<string | undefined> };

/**
 * Pictures are keyed by server origin and account. An entry stays valid for as long as its revision matches the
 * one the server last reported (presence or own account); without a known revision it expires after a few minutes.
 * Failed downloads are remembered briefly so a rate-limited server is not asked again on every remount.
 */
export function createProfilePictureCache() {
  const cache = new Map<string, CachedPicture>();

  function store(key: string, entry: CachedPicture) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  }

  function get(origin: string, accountId: string, avatarId?: string | null) {
    const key = origin + "/" + accountId;
    const existing = cache.get(key);
    const fresh = existing && existing.expires > Date.now();
    if (existing && (existing.failed || avatarId === undefined ? fresh : avatarId === existing.avatarId)) {
      store(key, existing);
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
        entry.failed = true;
        entry.expires = Date.now() + failureRetryMs;
        return undefined;
      });
    }
    store(key, entry);
    return entry.source;
  }

  function set(origin: string, accountId: string, avatarId: string | null, data: string | null) {
    const source = avatarId && data ? pngPrefix + data : undefined;
    store(origin + "/" + accountId, { avatarId, expires: Date.now() + cacheLifetimeMs, source: Promise.resolve(source) });
  }

  return { get, set };
}
