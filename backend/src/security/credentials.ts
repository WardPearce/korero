import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { atomicWrite, privateDirectory } from "./files";
import { readPrivate } from "./tls";

export const randomToken = () => randomBytes(32).toString("base64url");
export function equalDigest(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
export class Credentials {
  constructor(private readonly secret: Uint8Array) {}
  digest(domain: "access" | "refresh" | "invitation" | "setup" | "ticket" | "hosted-account", token: string) {
    return createHmac("sha256", this.secret).update(`voice/v1/verifier/${domain}\0`).update(token).digest("hex");
  }
  successor(domain: "access" | "refresh", previous: string) {
    return createHmac("sha256", this.secret).update(`voice/v1/refresh-successor/${domain}\0`).update(previous).digest("base64url");
  }
}

export async function loadCredentials(directory: string, initialized: boolean) {
  const secrets = join(directory, "secrets");
  await privateDirectory(secrets);
  const path = join(secrets, "credentials.key");
  let bytes: Uint8Array;
  try { bytes = await readPrivate(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (initialized) throw new Error("Credential secret missing. Restore secrets/credentials.key from backup");
    bytes = randomBytes(32);
    await atomicWrite(path, bytes);
  }
  if (bytes.length !== 32) throw new Error("Invalid credential secret");
  return new Credentials(bytes);
}
