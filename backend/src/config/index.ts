import { getSchemaValidator, t } from "elysia";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

const integer = (minimum: number, maximum: number) => t.Integer({ minimum, maximum });
const port = integer(1, 65535);
const string = t.String({ maxLength: 2048 });
const list = t.Array(string, { maxItems: 32 });
const object = <P extends Parameters<typeof t.Object>[0]>(properties: P) => t.Object(properties, { additionalProperties: false });
const configuration = object({
  server: object({ name: t.String({ minLength: 1, maxLength: 100, pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$" }), host: string, port,
    max_users: integer(1, 10000), registration: t.UnionEnum(["open", "invitation", "admin", "disabled"]),
    origins: list, public_addresses: list, trusted_proxies: list, password: t.String({ maxLength: 128 }) }),
  tls: object({ mode: t.UnionEnum(["self-signed", "manual", "proxy"]), certificate: string, private_key: string, names: list }),
  media: object({ listen: t.Array(object({ ip: string, announced_address: t.Optional(string) }), { maxItems: 32 }), listen_ips: list, listen_ip: string, announced_address: string, announced_ipv6: string,
    port, workers: integer(1, 32), target_audio_bitrate: integer(32000, 128000), enable_udp: t.Boolean(), enable_tcp: t.Boolean(),
    ice_servers: t.Array(object({ urls: list, username: t.Optional(string), credential: t.Optional(string) }), { maxItems: 8 }) }),
  authentication: object({ access_seconds: integer(1, 86400), refresh_seconds: integer(2, 31536000),
    setup_seconds: integer(30, 86400), ticket_seconds: integer(2, 120), refresh_retry_seconds: integer(1, 60), max_sessions: integer(1, 1000) }),
  limits: object({ connections_per_account: integer(1, 32), pending_connections: integer(1, 2048), pending_connections_per_ip: integer(1, 2048),
    transports: integer(2, 16), producers: integer(1, 16), consumers: integer(1, 1024), users_per_channel: integer(1, 1024),
    websocket_bytes: integer(4096, 262144), websocket_pending: integer(1, 128), websocket_requests_per_minute: integer(10, 10000),
    media_per_minute: integer(1, 5000), ice_restarts_per_minute: integer(1, 100), auth_per_minute: integer(1, 1000),
    registration_per_minute: integer(1, 1000), upgrades_per_minute: integer(1, 1000), max_channels: integer(1, 10000) }),
  messaging: object({ persistence: t.Boolean(), retention_hours: integer(1, 8760), max_length: integer(1, 8192), per_minute: integer(1, 1000) }),
});
type Settings = typeof configuration.static;
const defaults: Settings = {
  server: { name: "Voice Server", host: "::", port: 8443, max_users: 128, registration: "open", origins: [], public_addresses: [], trusted_proxies: [], password: "" },
  tls: { mode: "self-signed", certificate: "", private_key: "", names: [] },
  media: { listen: [], listen_ips: [], listen_ip: "", announced_address: "", announced_ipv6: "", port: 8444, workers: 1,
    target_audio_bitrate: 48000, enable_udp: true, enable_tcp: true, ice_servers: [] },
  authentication: { access_seconds: 900, refresh_seconds: 7776000, setup_seconds: 900, ticket_seconds: 20, refresh_retry_seconds: 10, max_sessions: 32 },
  limits: { connections_per_account: 4, pending_connections: 32, pending_connections_per_ip: 4, transports: 2, producers: 1, consumers: 128, users_per_channel: 32,
    websocket_bytes: 65536, websocket_pending: 16, websocket_requests_per_minute: 1200, media_per_minute: 360, ice_restarts_per_minute: 6,
    auth_per_minute: 30, registration_per_minute: 12, upgrades_per_minute: 60, max_channels: 1024 },
  messaging: { persistence: false, retention_hours: 24, max_length: 2000, per_minute: 20 },
};
export const localAddresses = () => [...new Set(Object.values(networkInterfaces()).flatMap((entries) =>
  (entries ?? []).filter(({ address }) => !address.toLowerCase().startsWith("fe80:")).map(({ address }) => address)))];
export const endpoint = (host: string, port: number) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
export type Config = Settings & { directory: string; file: string; mediaAddresses: { ip: string; announcedAddress?: string }[] };
const validator = getSchemaValidator(configuration, { normalize: false })!;

function objectValue(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export async function loadConfig(options: { file?: string; directory?: string } = {}): Promise<Config> {
  const hint = options.directory ?? process.env.VOICE_DATA_DIR;
  const selected = options.file ?? process.env.VOICE_CONFIG;
  const file = resolve(selected ?? resolve(hint ?? "./data", "server.toml"));
  let raw: unknown = {};
  if (existsSync(file)) {
    try { raw = Bun.TOML.parse(await Bun.file(file).text()); }
    catch { throw new Error(`Invalid TOML in ${file}`); }
  } else if (selected) throw new Error(`Configuration file does not exist: ${file}`);
  if (!objectValue(raw)) throw new Error("Expected a configuration table");
  const directorySetting = raw.storage;
  if (directorySetting !== undefined && (!objectValue(directorySetting) ||
      Object.keys(directorySetting).some((key) => key !== "directory") ||
      typeof directorySetting.directory !== "string" || !directorySetting.directory)) throw new Error("Invalid storage.directory");
  const directory = resolve(hint ?? (objectValue(directorySetting) ? String(directorySetting.directory) : "./data"));
  const merged: Record<string, unknown> = {};
  for (const [section, values] of Object.entries(defaults)) {
    const settings = raw[section] ?? {};
    if (!objectValue(settings)) throw new Error(`Expected [${section}] table`);
    const next: Record<string, unknown> = { ...values, ...settings };
    if (section === "server" && next.registration === "closed") next.registration = "disabled";
    for (const [key, value] of Object.entries(values)) {
      const env = process.env[`VOICE_${section.toUpperCase()}_${key.toUpperCase()}`];
      if (env === undefined) continue;
      try { next[key] = typeof value === "string" ? env : JSON.parse(env); }
      catch { throw new Error(`Invalid environment override for ${section}.${key}`); }
    }
    merged[section] = next;
  }
  for (const section of Object.keys(raw)) {
    if (section !== "storage" && !Object.hasOwn(defaults, section)) throw new Error(`Unknown configuration section: ${section}`);
  }
  if (!validator.Check(merged)) {
    const error = validator.Errors(merged).First();
    throw new Error(`Invalid configuration at ${error?.path || "/"}: ${error?.message ?? "invalid value"}`);
  }
  const settings = merged as Settings;
  const { server, tls, media, authentication } = settings;
  if (!isIP(server.host)) throw new Error("server.host must be an IPv4 or IPv6 literal");
  if (tls.mode === "proxy" && !server.trusted_proxies.length) {
    throw new Error("Proxy TLS requires the exact IP addresses of explicitly trusted proxies");
  }
  if (server.trusted_proxies.some((ip) => !isIP(ip) || ip === "::" || ip === "0.0.0.0")) throw new Error("Invalid trusted proxy IP");
  if (tls.mode === "manual" && (!tls.certificate || !tls.private_key)) throw new Error("Manual TLS requires tls.certificate and tls.private_key");
  if (server.origins.some((origin) => { try { return new URL(origin).origin !== origin || !/^https?:\/\//.test(origin); } catch { return true; } })) {
    throw new Error("server.origins must contain exact HTTP(S) origins");
  }
  if (authentication.refresh_seconds <= Math.max(authentication.access_seconds, authentication.refresh_retry_seconds)) {
    throw new Error("Refresh lifetime must exceed access lifetime and retry window");
  }
  if (!media.enable_udp && !media.enable_tcp) throw new Error("Enable at least one media transport protocol");
  if (media.port + media.workers - 1 > 65535 || (media.enable_tcp && server.port >= media.port && server.port < media.port + media.workers)) {
    throw new Error("Media worker ports overflow or overlap the HTTP port");
  }
  if ([Boolean(media.listen_ip), Boolean(media.listen_ips.length), Boolean(media.listen.length)].filter(Boolean).length > 1) {
    throw new Error("Use only one of media.listen, media.listen_ip and media.listen_ips");
  }
  if (media.listen.length && (media.announced_address || media.announced_ipv6)) {
    throw new Error("Specify announced addresses inside media.listen entries when using that option");
  }
  if (media.announced_ipv6 && isIP(media.announced_ipv6) !== 6) throw new Error("media.announced_ipv6 must be an IPv6 literal");
  const announced = (ip: string) => isIP(ip) === 6 ? media.announced_ipv6 || (isIP(media.announced_address) === 6 ? media.announced_address : "") :
    isIP(media.announced_address) !== 6 ? media.announced_address : "";
  const hostName = (name: string) => name.length <= 253 &&
    name.split(".").every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part));
  const names = [...tls.names, ...server.public_addresses,
    ...media.listen.flatMap((entry) => entry.announced_address ? [entry.announced_address] : []),
    ...(media.announced_address ? [media.announced_address] : [])];
  if (names.some((name) => !isIP(name) && !hostName(name))) {
    throw new Error("Configured public addresses and TLS names must be IP literals or DNS names without a port");
  }
  const defaultBinds = () => {
    const wildcard = [...(media.announced_address && isIP(media.announced_address) !== 6 ? ["0.0.0.0"] : []),
      ...(media.announced_ipv6 || isIP(media.announced_address) === 6 ? ["::"] : [])];
    return [...localAddresses().filter((ip) => !wildcard.includes(isIP(ip) === 6 ? "::" : "0.0.0.0")), ...wildcard];
  };
  const hints = media.listen_ips.length ? media.listen_ips : media.listen_ip ? [media.listen_ip] : defaultBinds();
  const mediaAddresses = media.listen.length ? media.listen.map(({ ip, announced_address }) => ({ ip, announcedAddress: announced_address || undefined })) :
    [...new Set(hints)].map((ip) => ({ ip, announcedAddress: announced(ip) || undefined }));
  if (!mediaAddresses.length || mediaAddresses.some(({ ip }) => !isIP(ip) || ip.includes("%"))) {
    throw new Error("Media listen addresses must be unscoped IP literals");
  }
  if (new Set(mediaAddresses.map(({ ip }) => ip)).size !== mediaAddresses.length) throw new Error("Duplicate media listen address");
  for (const { ip, announcedAddress } of mediaAddresses) {
    if (announcedAddress && isIP(announcedAddress) && isIP(ip) !== isIP(announcedAddress)) {
      throw new Error("Announced IPs must match the family of their media bind");
    }
    const wildcard = isIP(ip) === 6 ? "::" : "0.0.0.0";
    if (ip === wildcard && (!announcedAddress || mediaAddresses.some(({ ip: other }) => other !== ip && isIP(other) === isIP(ip)))) {
      throw new Error("A wildcard media bind requires an announced address and cannot overlap another bind of the same family");
    }
  }
  for (const entry of media.ice_servers) {
    if (!entry.urls.length || entry.urls.some((url) => !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))) throw new Error("Invalid configured ICE server URL");
  }
  return { ...settings, directory, file, mediaAddresses };
}

export const defaultToml = `# Unspecified settings use safe defaults. See docs/deployment.md.
[server]
name = "Voice Server"
host = "::"
port = 8443
registration = "open"

[tls]
mode = "self-signed"

[media]
port = 8444
workers = 1
enable_udp = true
enable_tcp = true

[messaging]
persistence = false
`;
