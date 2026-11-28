import { getSchemaValidator, t } from "elysia";
import { channelPermissions, permissions } from "../database";
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
const deviceName = displayName;
const roleName = t.String({ minLength: 1, maxLength: 80, pattern: "^(?=.*\\S)[^/\\u0000-\\u001f\\u007f]+$" });
const requestId = int(1, Number.MAX_SAFE_INTEGER);
const identityProof = { id: token, signature: t.String({ pattern: "^[A-Za-z0-9_-]{86}$" }) };
const enrollmentProof = object(identityProof);
const password = text(128);
const invitationExpiry = int(1, 8640000000000000);
export const bytesPerMiB = 1024 * 1024;
export const defaultAttachmentMiB = 4;
export const maxSupportedAttachmentMiB = 32;
export const attachmentDataLength = (bytes: number) => Math.ceil(bytes / 3) * 4;
export const maxProfilePictureBytes = 192 * 1024;
export const maxScreenVideoBitrate = 12000000;
const richMessageHtml = optional(text(32768));
export const httpBodies = {
  identityChallenge: object({ operation: t.UnionEnum(["login", "register", "bootstrap"]),
    publicKey: t.String({ pattern: "^[A-Za-z0-9_-]{43}$" }), deviceName, origin: text(512) }),
  identityProof: object({ ...identityProof, password: optional(password) }),
  register: object({ displayName, deviceName, invitation: optional(token), password: optional(password), identity: enrollmentProof }),
  refresh: object({ refreshToken: token }),
  bootstrap: object({ token, displayName, deviceName, password: optional(password), identity: enrollmentProof }),
  account: object({ displayName }),
  profilePicture: object({
    data: nullable(t.String({ minLength: 4, maxLength: attachmentDataLength(maxProfilePictureBytes), pattern: "^[A-Za-z0-9+/]+={0,2}$" })),
  }),
  serverPassword: object({ password: nullable(password) }),
  invitationUpdate: object({ expiresAt: optional(nullable(invitationExpiry)), usesLeft: optional(nullable(int(0, 10000))) }),
  roleDefinition: object({ name: roleName, permissions: list(t.UnionEnum([...permissions]), permissions.length) }),
  accountBadge: object({ accountId: id, badge: nullable(t.String({
    minLength: 1, maxLength: 32, pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$",
  })) }),
  deleteRole: object({ name: roleName }),
  serverPreferences: object({
    motd: optional(t.String({ maxLength: 1000, pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$" })),
    defaultRole: optional(roleName),
    defaultAudioBitrate: optional(nullable(int(32000, 128000))),
    maxAttachmentMiB: optional(int(1, maxSupportedAttachmentMiB)),
  }),
  channelOrder: object({ channelId: id, targetId: id, placement: t.UnionEnum(["before", "after", "inside"]),
    parentId: optional(nullable(id)) }),
  serverBanner: object({ bannerImageUrl: nullable(text(512)) }),
  channelPermissions: object({ changes: list(object({ role: roleName, permission: t.UnionEnum([...channelPermissions]),
    allow: nullable(t.Boolean()) }), 512, 1) }),
  attachmentUpload: object({
    connectionId: id, channelId: id, text: text(8192, 0), html: richMessageHtml,
    name: t.String({ minLength: 1, maxLength: 255, pattern: "^[^\\u0000-\\u001f\\u007f/:\\\\]+$" }),
    data: t.String({ minLength: 4, maxLength: attachmentDataLength(maxSupportedAttachmentMiB * bytesPerMiB), pattern: "^[A-Za-z0-9+/]+={0,2}$" }),
  }),
};
export const auditQuery = object({
  before: optional(t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 })),
  actorId: optional(id),
  prefix: optional(t.String({ pattern: "^[a-z]{1,24}$" })),
});

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
const codec = { mimeType: t.String({ pattern: "^([aA][uU][dD][iI][oO]/[oO][pP][uU][sS]|[vV][iI][dD][eE][oO]/([vV][pP]8|[rR][tT][xX]))$" }),
  clockRate: t.UnionEnum([48000, 90000]),
  channels: optional(int(1, 2)), parameters: codecParameters, rtcpFeedback };
const feedbackDirection = t.UnionEnum(["sendrecv", "sendonly", "recvonly", "inactive"]);
const rtpCapabilities = object({
  codecs: list(object({ kind: t.UnionEnum(["audio", "video"]), preferredPayloadType: payloadType, ...codec }), 4, 1),
  headerExtensions: optional(list(object({ kind: t.UnionEnum(["audio", "video"]), uri: headerUri, preferredId: int(1, 255),
    preferredEncrypt: optional(t.Boolean()), direction: optional(feedbackDirection) }), 32)),
});
const rtpParameters = object({
  mid: optional(text(32)), msid: optional(text(256)),
  codecs: list(object({ payloadType, ...codec }), 2, 1),
  headerExtensions: optional(list(object({ uri: headerUri, id: int(1, 255), encrypt: optional(t.Boolean()), parameters: codecParameters }), 32)),
  encodings: optional(list(object({ ssrc: optional(ssrc), rid: optional(text(32)), codecPayloadType: optional(payloadType),
    rtx: optional(object({ ssrc })), active: optional(t.Boolean()), dtx: optional(t.Boolean()), scalabilityMode: optional(t.Literal("L1T1")),
    maxBitrate: optional(int(1, maxScreenVideoBitrate)) }), 1, 1)),
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
const channelIcon = t.String({ minLength: 1, maxLength: 16, pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$" });
const channelDetails = {
  name: displayName,
  description: optional(text(1000, 0)),
  parentId: optional(nullable(id)),
  position: optional(int(0, 100000)),
  capacity: optional(nullable(int(1, 1024))),
  password: optional(nullable(text(128))),
  backgroundImageUrl: optional(nullable(text(512))),
  icon: optional(nullable(channelIcon)),
  audioBitrate: optional(nullable(int(32000, 128000))),
};
const directAccount = { accountId: id };
const directCursor = object({ id, createdAt: int(1, Number.MAX_SAFE_INTEGER) });
export const pokeMaxLength = 200;
const base64url = (minLength: number, maxLength = minLength) => t.String({ minLength, maxLength, pattern: "^[A-Za-z0-9_-]+$" });
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
  "channel.view": object({ channelId: nullable(id) }),
  "channel.move": t.Union([
    object({ connectionId: id, channelId: id }),
    object({ connectionIds: list(id, 1024, 1), channelId: id }),
  ]),
  "presence.set": object({ muted: optional(t.Boolean()), deafened: optional(t.Boolean()), afk: optional(t.Boolean()),
    afkMessage: optional(t.String({ maxLength: 120, pattern: "^[^\\u0000-\\u001f\\u007f]*$" })) }),
  "role.add": object({ accountId: id, role: roleName }),
  "role.remove": object({ accountId: id, role: roleName }),
  "channel.override": object({ channelId: id, role: roleName, permission: t.UnionEnum([...channelPermissions]), allow: nullable(t.Boolean()) }),
  "moderation.mute": object({ connectionId: id, muted: t.Boolean() }),
  "moderation.deafen": object({ connectionId: id, deafened: t.Boolean() }),
  "moderation.kick": object({ accountId: id }),
  "moderation.ban": object({ accountId: id, expiresInSeconds: optional(int(1, 31536000)) }),
  "moderation.unban": object({ accountId: id }),
  "invitation.create": object({ expiresInSeconds: optional(int(1, 31536000)), expiresAt: optional(invitationExpiry),
    uses: optional(int(1, 10000)) }),
  "invitation.list": empty,
  "invitation.update": object({ invitationId: id, ...httpBodies.invitationUpdate.properties }),
  "invitation.revoke": object({ invitationId: id }),
  "admin.diagnostics": empty,
  "admin.audit": object({ before: optional(int(1, Number.MAX_SAFE_INTEGER)) }),
  "server.settings": object({ name: optional(displayName) }),
  "message.send": object({ channelId: id, text: text(8192), html: richMessageHtml }),
  "message.history": object({ channelId: id, before: optional(int(1, Number.MAX_SAFE_INTEGER)) }),
  "message.context": object({ channelId: id, messageId: id }),
  "message.pins": object({ channelId: id, before: optional(object({ id, pinnedAt: int(1, Number.MAX_SAFE_INTEGER) })) }),
  "message.pin": object({ channelId: id, messageId: id, pinned: t.Boolean() }),
  "message.delete": object({ messageId: id }),
  "direct.peer": object(directAccount),
  "direct.inbox": empty,
  "direct.history": object({ ...directAccount, before: optional(directCursor) }),
  "direct.send": object({ ...directAccount, id, nonce: base64url(16), ciphertext: base64url(23, 10944), signature: base64url(86) }),
  "message.edit": object({ messageId: id, text: text(8192, 0), html: richMessageHtml }),
  "direct.edit": object({ ...directAccount, id, nonce: base64url(16), ciphertext: base64url(23, 10944), signature: base64url(86) }),
  "direct.delete": object({ ...directAccount, id }),
  "direct.pending": empty,
  "direct.ack": object({ ids: list(id, 100, 1) }),
  "direct.poke": object({ ...directAccount, message: optional(t.String({ maxLength: pokeMaxLength, pattern: "^[^\\u0000-\\u001f\\u007f]*$" })) }),
  "media.capabilities": object({ kind: optional(t.Literal("video")) }),
  "media.transport.create": object({ direction: t.UnionEnum(["send", "receive"]), forceTcp: optional(t.Boolean()),
    kind: optional(t.Literal("video")), videoSource: optional(t.Literal("camera")),
    whisperChannelId: optional(id), whisperPassword: optional(text(128)) }),
  "media.transport.connect": object({ transportId: id, dtlsParameters }),
  "media.transport.close": transportId,
  "media.transport.stats": transportId,
  "media.ice.restart": transportId,
  "media.producers": empty,
  "media.producer.create": object({ transportId: id, kind: t.UnionEnum(["audio", "video"]), rtpParameters }),
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
