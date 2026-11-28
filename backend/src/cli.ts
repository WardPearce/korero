import { mkdir, chmod, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { constants } from "node:crypto";
import { styleText } from "node:util";
import { createApp } from "./app";
import { configToml, defaultToml, endpoint, loadConfig, localAddresses, type Config } from "./config";
import { lockDirectory, openDatabase, audit, snapshotDatabase, type Store } from "./database";
import { accounts, hostedAccounts, metadata, settings } from "./database/schema";
import { Auth } from "./modules/auth";
import { HostedAccounts } from "./modules/hosted-accounts";
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
  const name = db.select({ value: settings.value }).from(settings).where(eq(settings.key, "name")).get()?.value;
  if (name && !process.env.VOICE_SERVER_NAME) config.server.name = name;
  // Registration and max_users are host-only settings; discard any legacy saved value.
  db.delete(settings).where(eq(settings.key, "registration")).run();
}

function terminalStyle(style: Parameters<typeof styleText>[0], value: string) {
  return process.stdout.isTTY && !process.env.NO_COLOR ? styleText(style, value) : value;
}

function formatSetup(setup: { token: string; expiresAt: number }) {
  return [
    terminalStyle(["bold", "yellow"], "ADMIN SETUP TOKEN"),
    `  ${terminalStyle("bold", setup.token)}`,
    "  Use this one-time token to create the first owner.",
    `  Expires ${new Date(setup.expiresAt).toISOString()}`,
  ].join("\n");
}

function printStartup(config: Config, serverId: string, fingerprint: string | undefined, setup: ReturnType<Auth["issueSetup"]>) {
  const local = config.server.host === "::" ? localAddresses() :
    config.server.host === "0.0.0.0" ? localAddresses().filter((ip) => !ip.includes(":")) : [config.server.host];
  const signalling = local.map((address) => endpoint(address, config.server.port));
  const publicAddresses = config.server.public_addresses.map((address) => endpoint(address, config.server.port));
  const ports = config.media.workers > 1 ? `${config.media.port}–${config.media.port + config.media.workers - 1}` : `${config.media.port}`;
  const protocols = [config.media.enable_udp && "UDP", config.media.enable_tcp && "TCP"].filter(Boolean).join("/");
  const field = (label: string, ...values: string[]) => {
    const width = "TLS key fingerprint".length + 2;
    return values.map((value, index) => `  ${(index === 0 ? label : "").padEnd(width)}${value}`);
  };

  console.log([
    terminalStyle("bold", `${config.server.name} v${version}`),
    "",
    ...(setup ? [formatSetup(setup), ""] : []),
    ...field("Signalling", ...signalling),
    ...field("Public", ...(publicAddresses.length ? publicAddresses : ["none configured"])),
    ...field("Media", `${ports} ${protocols}`),
    "",
    ...(fingerprint ? field("TLS key fingerprint", fingerprint) : []),
    ...field("Server ID", serverId),
    ...field("Data directory", config.directory),
    ...field("Registration", config.server.registration),
    ...field("Remote accounts", config["remote-account-host"].registration),
  ].join("\n"));
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
  const toml = await configToml(config);
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

async function start(db: Store, auth: Auth, hosted: HostedAccounts, config: Config) {
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
    const app = createApp(config, auth, hosted, media, realtime, { serverId, fingerprint: tls?.fingerprint });
    app.listen({ hostname: config.server.host, port: config.server.port, reusePort: false,
      websocket: {
        // Elysia's route-level pong handler drops the frame payload.
        pong(socket, payload) {
          const data: unknown = socket.data;
          if (data && typeof data === "object" && "id" in data && typeof data.id === "string") {
            realtime?.receivedPong(data.id, payload);
          }
        },
      },
      ...(tls ? { tls: { key: tls.key, cert: tls.cert, secureOptions: constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1 } } : {}) });
    stopListener = () => app.stop(true);
    printStartup(config, serverId, tls?.fingerprint, auth.issueSetup());
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
    const initialized = Boolean(db.select({ id: accounts.id }).from(accounts).limit(1).get() ||
      db.select({ username: hostedAccounts.username }).from(hostedAccounts).limit(1).get());
    const credentials = await loadCredentials(config.directory, initialized);
    const auth = new Auth(db, credentials, config);
    applySettings(db, config);
    if (!auth.passwordLocked && config.server.password) auth.syncConfiguredServerPassword(config.server.password);
    switch (options.command) {
      case "start":
        if (config.inlineConfig === undefined && !existsSync(config.file)) await atomicWrite(config.file, defaultToml);
        await start(db, auth, new HostedAccounts(db, credentials, config), config);
        break;
      case "admin setup-token": console.log(formatSetup(auth.issueSetup(true)!)); break;
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
