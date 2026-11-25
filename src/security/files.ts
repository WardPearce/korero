import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const workerBuildPolicy = "system-openssl-3.5.9-v1";

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022)) {
    throw new Error(`Directory must be owned by the server and writable only by its owner: ${path}`);
  }
}

export async function atomicWrite(path: string, bytes: Uint8Array | string, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", mode);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function extractWorker(directory: string, version: string, bytes: Uint8Array, digest: string) {
  if (sha256(bytes) !== digest) throw new Error("Embedded worker integrity check failed");
  const workers = join(directory, "workers");
  await privateDirectory(workers);
  const target = join(workers, `${version}-${process.platform}-${process.arch}-${digest}`);
  await privateDirectory(target);
  const path = join(target, "mediasoup-worker");
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 ||
          info.size !== bytes.length || sha256(await file.readFile()) !== digest) {
        throw new Error("Extracted media worker failed integrity or permissions validation");
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(path, bytes, 0o700);
  }
  process.env.MEDIASOUP_WORKER_BIN = path;
  return path;
}
