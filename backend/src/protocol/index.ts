import { getSchemaValidator, t } from "elysia";
import { channelPermissions, roles } from "../database";
import { fail } from "../security/errors";

const object = <P extends Parameters<typeof t.Object>[0]>(properties: P) => t.Object(properties, { additionalProperties: false });
const text = (maximum: number, minimum = 1) => t.String({ minLength: minimum, maxLength: maximum });
const int = (minimum: number, maximum: number) => t.Integer({ minimum, maximum });
const list = <S extends Parameters<typeof t.Array>[0]>(items: S, maxItems: number, minItems = 0) => t.Array(items, { minItems, maxItems });
const optional = t.Optional;
const nullable = <S extends Parameters<typeof t.Optional>[0]>(schema: S) => t.Union([schema, t.Null()]);
const empty = object({});
export const id = t.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" });
export const token = t.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
const displayName = t.String({ minLength: 1, maxLength: 80, pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$" });
const recoveryCode = text(128);
const deviceName = displayName;
const requestId = int(1, Number.MAX_SAFE_INTEGER);
export const httpBodies = {
  register: object({ displayName, deviceName, invitation: optional(token) }),
  recover: object({ recoveryCode, deviceName }),
  refresh: object({ refreshToken: token }),
  rotate: object({ recoveryCode, revokeOthers: optional(t.Boolean()) }),
  bootstrap: object({ token, displayName, deviceName }),
  account: object({ displayName }),
};

const codecParameters = optional(t.Record(t.String({ pattern: "^(?!constructor$|prototype$|__proto__$)[a-zA-Z0-9_-]{1,64}$" }),
  t.Union([text(256, 0), t.Number(), t.Boolean()]), { maxProperties: 48 }));
const rtcpFeedback = optional(list(object({ type: text(64), parameter: optional(text(64, 0)) }), 16));
const headerUri = t.UnionEnum([
  "urn:ietf:params:rtp-hdrext:sdes:mid", "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
  "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id", "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01", "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension", "urn:3gpp:video-orientation",
  "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time", "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
  "urn:mediasoup:params:rtp-hdrext:packet-id",
]);
const payloadType = int(0, 127);
const ssrc = int(1, 4294967295);
const codec = { mimeType: t.String({ pattern: "^[aA][uU][dD][iI][oO]/[oO][pP][uU][sS]$" }), clockRate: t.Literal(48000),
  channels: optional(int(1, 2)), parameters: codecParameters, rtcpFeedback };
const feedbackDirection = t.UnionEnum(["sendrecv", "sendonly", "recvonly", "inactive"]);
const rtpCapabilities = object({
  codecs: list(object({ kind: t.Literal("audio"), preferredPayloadType: payloadType, ...codec }), 4, 1),
  headerExtensions: optional(list(object({ kind: t.UnionEnum(["audio", "video"]), uri: headerUri, preferredId: int(1, 255),
    preferredEncrypt: optional(t.Boolean()), direction: optional(feedbackDirection) }), 32)),
});
const rtpParameters = object({
  mid: optional(text(32)), msid: optional(text(256)),
  codecs: list(object({ payloadType, ...codec }), 1, 1),
  headerExtensions: optional(list(object({ uri: headerUri, id: int(1, 255), encrypt: optional(t.Boolean()), parameters: codecParameters }), 32)),
  encodings: optional(list(object({ ssrc: optional(ssrc), rid: optional(text(32)), codecPayloadType: optional(payloadType),
    dtx: optional(t.Boolean()), scalabilityMode: optional(t.Literal("L1T1")), maxBitrate: optional(int(1, 1000000)) }), 1, 1)),
  rtcp: optional(object({ cname: optional(text(256)), reducedSize: optional(t.Boolean()), mux: optional(t.Boolean()) })),
});
const dtlsParameters = object({
  role: optional(t.UnionEnum(["auto", "client", "server"])),
  fingerprints: list(object({ algorithm: t.UnionEnum(["sha-1", "sha-224", "sha-256", "sha-384", "sha-512"]),
    value: t.String({ minLength: 59, maxLength: 191, pattern: "^[A-Fa-f0-9]{2}(:[A-Fa-f0-9]{2})+$" }) }), 8, 1),
});
const transportId = object({ transportId: id });
const producerId = object({ producerId: id });
const consumerId = object({ consumerId: id });
const channelId = object({ channelId: id });
const channelDetails = {
  name: displayName,
  description: optional(text(1000, 0)),
  parentId: optional(nullable(id)),
  position: optional(int(0, 100000)),
  capacity: optional(nullable(int(1, 1024))),
  password: optional(nullable(text(128))),
};
const target = object({ channelId: optional(id), accountId: optional(id) });
export const payloads = {
  "connection.authenticate": object({ ticket: token, versions: list(int(1, 100000), 16, 1) }),
  "connection.renew": object({ ticket: token }),
  "heartbeat": empty,
  "state.get": empty,
  "channel.create": object({ ...channelDetails, temporary: optional(t.Boolean()) }),
  "channel.edit": object({ ...channelDetails, name: optional(displayName), channelId: id }),
  "channel.delete": channelId,
  "channel.join": object({ channelId: id, password: optional(text(128)) }),
  "channel.leave": empty,
  "channel.move": object({ connectionId: id, channelId: id }),
  "presence.set": object({ muted: optional(t.Boolean()), deafened: optional(t.Boolean()) }),
  "role.set": object({ accountId: id, role: t.UnionEnum([...roles]) }),
  "channel.override": object({ channelId: id, role: t.UnionEnum([...roles]), permission: t.UnionEnum([...channelPermissions]), allow: nullable(t.Boolean()) }),
  "moderation.mute": object({ connectionId: id, muted: t.Boolean() }),
  "moderation.kick": object({ accountId: id }),
  "moderation.ban": object({ accountId: id, expiresInSeconds: optional(int(1, 31536000)) }),
  "moderation.unban": object({ accountId: id }),
  "invitation.create": object({ expiresInSeconds: optional(int(1, 31536000)), uses: optional(int(1, 10000)) }),
  "invitation.list": empty,
  "invitation.revoke": object({ invitationId: id }),
  "admin.diagnostics": empty,
  "admin.audit": object({ before: optional(int(1, Number.MAX_SAFE_INTEGER)) }),
  "server.settings": object({ name: optional(displayName), registration: optional(t.UnionEnum(["open", "invitation", "admin", "disabled"])) }),
  "message.send": object({ ...target.properties, text: text(8192) }),
  "message.history": object({ ...target.properties, before: optional(int(1, Number.MAX_SAFE_INTEGER)) }),
  "message.delete": object({ messageId: id }),
  "media.capabilities": empty,
  "media.transport.create": object({ direction: t.UnionEnum(["send", "receive"]), forceTcp: optional(t.Boolean()) }),
  "media.transport.connect": object({ transportId: id, dtlsParameters }),
  "media.transport.close": transportId,
  "media.transport.stats": transportId,
  "media.ice.restart": transportId,
  "media.producers": empty,
  "media.producer.create": object({ transportId: id, kind: t.Literal("audio"), rtpParameters }),
  "media.producer.pause": producerId,
  "media.producer.resume": producerId,
  "media.producer.close": producerId,
  "media.consumer.create": object({ transportId: id, producerId: id, rtpCapabilities }),
  "media.consumer.pause": consumerId,
  "media.consumer.resume": consumerId,
  "media.consumer.close": consumerId,
};
export type RequestType = keyof typeof payloads;
export type Request = { [Name in RequestType]: { version: 1; id: number; type: Name; payload: typeof payloads[Name]["static"] } }[RequestType];
export const envelope = object({ version: int(1, 100000), id: requestId, type: text(64), payload: t.Unknown() });
const envelopeValidator = getSchemaValidator(envelope, { normalize: false })!;
const validators = Object.fromEntries(Object.entries(payloads).map(([name, schema]) =>
  [name, getSchemaValidator(schema, { normalize: false })!]));
export function decode(message: unknown): Request {
  if (!envelopeValidator.Check(message)) fail("INVALID_REQUEST");
  const { version, type, payload } = message as typeof envelope.static;
  if (version !== 1) fail("VERSION_UNSUPPORTED");
  if (!Object.hasOwn(validators, type) || !validators[type]!.Check(payload)) fail("INVALID_REQUEST");
  return message as Request;
}
export const version = 1;
