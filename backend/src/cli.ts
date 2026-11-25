import { mkdir, chmod, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { constants } from "node:crypto";
import { createApp } from "./app";
import { defaultToml, endpoint, loadConfig, localAddresses, type Config } from "./config";
import { lockDirectory, openDatabase, audit, snapshotDatabase, type Store } from "./database";
import { accounts, metadata, settings } from "./database/schema";
import { Auth } from "./modules/auth";
import { Media } from "./modules/media";
import { Realtime } from "./modules/realtime";
import { loadCredentials } from "./security/credentials";
import { atomicWrite, extractWorker, privateDirectory, sha256, workerBuildPolicy } from "./security/files";
import { identity, readPrivate } from "./security/tls";
import { dependencies, version } from "../package.json";

declare const EMBEDDED_WORKER: { path: string; sha256: string; version: string } | undefined;

const help = `Usage: voice-server [--config PATH] [--data-dir PATH] [COMMAND]

  start                     Start the voice server (default)
  config validate           Validate TOML and environment settings
  identity fingerprint      Show the local TLS public-key fingerprint
  identity export           Print the local public certificate in PEM format
  identity rotate --yes     Replace the local self-signed TLS identity
  admin setup-token --yes   Issue a new first-owner setup token
  backup --output PATH      Write a complete offline backup into a new directory
  --help                    Print this help
  --version                 Print the server version
`;

function parse(args: string[]) {
  const values: { file?: string; directory?: string; output?: string; yes: boolean; command: string } = { yes: false, command: "start" };
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes") { values.yes = true; continue; }
    if (arg === "--config" || arg === "--data-dir" || arg === "--output") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      values[arg === "--config" ? "file" : arg === "--data-dir" ? "directory" : "output"] = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown argument ${arg}`);
    else words.push(arg);
  }
  values.command = words.join(" ") || "start";
  if (!["start", "config validate", "identity fingerprint", "identity export", "identity rotate", "admin setup-token", "backup"].includes(values.command)) {
    throw new Error("Unknown command. Run voice-server --help");
  }
  if (values.output && values.command !== "backup") throw new Error("--output is only supported by backup");
  return values;
}

function applySettings(db: Store, config: Config) {
  const value = (key: string) => db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value;
  const name = value("name");
  const mode = value("registration");
  const registration = (["open", "invitation", "admin", "disabled"] as const).find((entry) => entry === mode);
  if (name && !process.env.VOICE_SERVER_NAME) config.server.name = name;
  if (registration && !process.env.VOICE_SERVER_REGISTRATION) config.server.registration = registration;
}

function applyServerPassword(db: Store, auth: Auth, config: Config) {
  if (process.env.VOICE_SERVER_PASSWORD !== undefined) return;
  const password = config.server.password;
  if (!password) return;
  auth.syncConfiguredServerPassword(password);
}

function printSetup(setup: { token: string; expiresAt: number }) {
  console.log(`First-owner setup token (expires ${new Date(setup.expiresAt).toISOString()}): ${setup.token}`);
}

async function prepareDirectory(directory: string) {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await privateDirectory(directory);
  for (const name of ["server.db", "server.db-wal", "server.db-shm", "instance.lock.sqlite", "instance.lock.sqlite-journal"]) {
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error(`Unsafe database path: ${path}`);
      if (info.mode & 0o077) await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function backup(db: Store, config: Config, destination: string) {
  if (!destination) throw new Error("backup requires --output PATH");
  const output = resolve(destination);
  const pathFromData = relative(config.directory, output);
  if (!pathFromData || (pathFromData !== ".." && !pathFromData.startsWith("../"))) throw new Error("Back up to a new directory outside the data directory");
  const additional: Array<[string, string]> = [];
  const certificate = join(config.directory, "identity", "tls.pem");
  if (existsSync(certificate)) additional.push(["identity/tls.pem", certificate]);
  if (config.tls.mode === "manual") {
    additional.push(["manual/tls.crt", config.tls.certificate], ["manual/tls.key", config.tls.private_key]);
  }
  const secret = await readPrivate(join(config.directory, "secrets", "credentials.key"));
  const toml = existsSync(config.file) ? await Bun.file(config.file).text() : defaultToml;
  await mkdir(output, { mode: 0o700 });
  snapshotDatabase(db, join(output, "server.db"));
  await chmod(join(output, "server.db"), 0o600);
  await atomicWrite(join(output, "server.toml"), toml);
  await mkdir(join(output, "secrets"), { mode: 0o700 });
  await atomicWrite(join(output, "secrets", "credentials.key"), secret);
  for (const [file, source] of additional) {
    await mkdir(dirname(join(output, file)), { mode: 0o700, recursive: true });
    const bytes = file.endsWith(".crt") ? await Bun.file(source).bytes() : await readPrivate(source);
    await atomicWrite(join(output, file), bytes);
  }
  await atomicWrite(join(output, "BACKUP_COMPLETE"), new Date().toISOString() + "\n");
  console.log(`Backup saved in ${output}`);
}

async function start(db: Store, auth: Auth, config: Config) {
  const tls = await identity(config);
  delete process.env.MEDIASOUP_USE_VALGRIND;
  delete process.env.MEDIASOUP_VERSION;
  if (typeof EMBEDDED_WORKER !== "undefined" && EMBEDDED_WORKER) {
    await extractWorker(config.directory, EMBEDDED_WORKER.version, await Bun.file(EMBEDDED_WORKER.path).bytes(), EMBEDDED_WORKER.sha256);
  } else {
    const packageDirectory = dirname(Bun.resolveSync("mediasoup", import.meta.dir));
    const path = resolve(packageDirectory, "../../worker/out/Release/mediasoup-worker");
    const stamp = await Bun.file(path + ".korero-build.json").json().catch(() => null);
    const bytes = await Bun.file(path).bytes().catch(() => null);
    if (!bytes || stamp?.version !== dependencies.mediasoup || stamp?.platform !== `${process.platform}-${process.arch}` ||
        stamp?.policy !== workerBuildPolicy || stamp?.sha256 !== sha256(bytes)) {
      throw new Error("Verified development worker missing. Run bun run prepare:worker");
    }
    process.env.MEDIASOUP_WORKER_BIN = path;
  }
  const serverId = db.select({ value: metadata.value }).from(metadata).where(eq(metadata.key, "serverId")).get()!.value;
  const media = new Media(config);
  let realtime: Realtime | undefined;
  let stopListener: (() => unknown) | undefined;
  let resolveStop: (() => void) | undefined;
  const stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
  process.once("SIGINT", resolveStop!);
  process.once("SIGTERM", resolveStop!);
  try {
    try { await media.start(); }
    catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Media worker could not start. Check OpenSSL 3.5.9+, media addresses and port availability (${detail})`);
    }
    realtime = new Realtime(db, auth, media, config);
    const app = createApp(config, auth, media, realtime, { serverId, fingerprint: tls?.fingerprint });
    const setup = auth.issueSetup();
    if (setup) printSetup(setup);
    app.listen({ hostname: config.server.host, port: config.server.port, reusePort: false,
      ...(tls ? { tls: { key: tls.key, cert: tls.cert, secureOptions: constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1 } } : {}) });
    stopListener = () => app.stop(true);
    const local = config.server.host === "::" ? localAddresses() :
      config.server.host === "0.0.0.0" ? localAddresses().filter((ip) => !ip.includes(":")) : [config.server.host];
    console.log(`${config.server.name} v${version} (${serverId})`);
    console.log(`Signalling: ${local.map((address) => endpoint(address, config.server.port)).join(", ")}`);
    console.log(`Public: ${config.server.public_addresses.map((address) => endpoint(address, config.server.port)).join(", ") || "none configured"}`);
    console.log(`Media: ${config.media.port}${config.media.workers > 1 ? `–${config.media.port + config.media.workers - 1}` : ""} ${[config.media.enable_udp && "UDP", config.media.enable_tcp && "TCP"].filter(Boolean).join("/")}`);
    if (tls) console.log(`TLS public-key fingerprint: ${tls.fingerprint}`);
    console.log(`Data directory: ${config.directory}\nRegistration: ${config.server.registration}`);
    await stopping;
  } finally {
    process.removeListener("SIGINT", resolveStop!);
    process.removeListener("SIGTERM", resolveStop!);
    const closeConnections = realtime?.close();
    await stopListener?.();
    await media.close();
    await closeConnections;
  }
}

export async function cli(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) { console.log(help); return; }
  if (args.includes("--version")) { console.log(version); return; }
  const options = parse(args);
  const config = await loadConfig(options);
  if (options.command === "config validate") {
    if (config.tls.mode === "manual") await identity(config);
    console.log("Configuration is valid");
    return;
  }
  if (["identity rotate", "admin setup-token"].includes(options.command) && !options.yes) {
    throw new Error(`${options.command} requires --yes`);
  }
  process.umask(0o077);
  await prepareDirectory(config.directory);
  const release = lockDirectory(config.directory);
  let db: Store | undefined;
  try {
    db = openDatabase(config.directory);
    const initialized = !!db.select({ id: accounts.id }).from(accounts).limit(1).get();
    const auth = new Auth(db, await loadCredentials(config.directory, initialized), config);
    applySettings(db, config);
    applyServerPassword(db, auth, config);
    switch (options.command) {
      case "start":
        if (!existsSync(config.file)) await atomicWrite(config.file, defaultToml);
        await start(db, auth, config);
        break;
      case "admin setup-token": printSetup(auth.issueSetup(true)!); break;
      case "identity fingerprint":
      case "identity export":
      case "identity rotate": {
        const rotate = options.command === "identity rotate";
        if (rotate && config.tls.mode !== "self-signed") throw new Error("Identity rotation requires self-signed TLS");
        const tls = await identity(config, rotate);
        if (!tls) throw new Error("TLS identity is managed outside this process");
        if (rotate) audit(db, null, "identity.rotated", null);
        console.log(options.command === "identity export" ? tls.cert : tls.fingerprint);
        break;
      }
      case "backup": await backup(db, config, options.output ?? ""); break;
    }
  } finally {
    db?.$client.close();
    release();
  }
}
