import "reflect-metadata";
import { X509CertificateGenerator, SubjectAlternativeNameExtension, ExtendedKeyUsageExtension,
  ExtendedKeyUsage, KeyUsageFlags, KeyUsagesExtension, type JsonGeneralName } from "@peculiar/x509";
import { createHash, createPrivateKey, createPublicKey, X509Certificate, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { localAddresses, type Config } from "../config";
import { atomicWrite, privateDirectory } from "./files";

const day = 86400000;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

export async function readPrivate(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      throw new Error(`Private file must be owner-only: ${path}`);
    }
    return await file.readFile();
  } finally { await file.close(); }
}

export function fingerprint(pem: string) {
  return "sha256/" + createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
}

export async function identity(config: Config, rotate = false) {
  if (config.tls.mode === "proxy") return null;
  if (config.tls.mode === "manual") {
    const cert = await Bun.file(config.tls.certificate).text();
    const key = (await readPrivate(config.tls.private_key)).toString();
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(createPrivateKey(key)) || Date.now() < Date.parse(parsed.validFrom) || Date.now() >= Date.parse(parsed.validTo)) {
      throw new Error("Manual TLS certificate is expired, premature or does not match its private key");
    }
    return { cert, key, fingerprint: fingerprint(cert) };
  }
  const directory = join(config.directory, "identity");
  await privateDirectory(directory);
  const path = join(directory, "tls.pem");
  let key = "";
  let cert = "";
  if (!rotate) {
    try {
      const pem = (await readPrivate(path)).toString();
      key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)?.[0] ?? "";
      cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0] ?? "";
      if (!key || !cert) throw new Error("Invalid stored TLS identity");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const names = [...new Set(["localhost", "127.0.0.1", "::1", ...localAddresses(), ...config.tls.names,
    ...config.server.public_addresses, ...config.mediaAddresses.flatMap(({ ip, announcedAddress }) => [ip, announcedAddress])])]
    .filter((name): name is string => !!name && name !== "0.0.0.0" && name !== "::");
  if (cert) {
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(createPrivateKey(key))) throw new Error("Stored TLS key and certificate do not match");
    if (Date.parse(parsed.validTo) > Date.now() + 30 * day && Date.parse(parsed.validFrom) <= Date.now() &&
        names.every((name) => isIP(name) ? parsed.checkIP(name) : parsed.checkHost(name))) {
      return { cert, key, fingerprint: fingerprint(cert) };
    }
  }
  let keys: CryptoKeyPair;
  if (key) {
    const privateKey = createPrivateKey(key);
    keys = {
      privateKey: await crypto.subtle.importKey("pkcs8", Uint8Array.from(privateKey.export({ type: "pkcs8", format: "der" })), algorithm, true, ["sign"]),
      publicKey: await crypto.subtle.importKey("spki", Uint8Array.from(createPublicKey(privateKey).export({ type: "spki", format: "der" })), algorithm, true, ["verify"]),
    };
  } else keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const sans: JsonGeneralName[] = names.map((value) => ({ type: isIP(value) ? "ip" : "dns", value }));
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01" + randomBytes(15).toString("hex"), name: "CN=Voice Server",
    notBefore: new Date(Date.now() - 300000), notAfter: new Date(Date.now() + 365 * day),
    signingAlgorithm: algorithm, keys,
    extensions: [new SubjectAlternativeNameExtension(sans),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth])],
  });
  cert = certificate.toString("pem");
  key = createPrivateKey({ key: Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)), type: "pkcs8", format: "der" })
    .export({ type: "pkcs8", format: "pem" }).toString();
  await atomicWrite(path, `${key.trim()}\n${cert.trim()}\n`);
  return { cert, key, fingerprint: fingerprint(cert) };
}
