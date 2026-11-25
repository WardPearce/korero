import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { atomicWrite, privateDirectory } from "./files";
import { readPrivate } from "./tls";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function recoveryCode() {
  const bytes = randomBytes(32);
  let value = 0;
  let remaining = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    remaining += 8;
    while (remaining >= 5) {
      remaining -= 5;
      result += alphabet[(value >>> remaining) & 31];
    }
  }
  result += alphabet[(value << (5 - remaining)) & 31];
  return result.match(/.{1,4}/g)!.join("-");
}

export function normalizeRecovery(code: string) {
  const plain = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{51}[0G]$/.test(plain) ? plain : null;
}
export const randomToken = () => randomBytes(32).toString("base64url");
export function equalDigest(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
export class Credentials {
  constructor(private readonly secret: Uint8Array) {}
  digest(domain: "recovery" | "access" | "refresh" | "invitation" | "setup" | "ticket", token: string) {
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
