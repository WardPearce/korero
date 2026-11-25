import { envelope, httpBodies, payloads } from "../src/protocol";

const inbound = Object.entries(payloads).map(([type, payload]) => ({
  ...envelope,
  properties: { ...envelope.properties, version: { const: 1 }, type: { const: type }, payload },
}));
const response = {
  type: "object", additionalProperties: false,
  required: ["version", "id", "type", "success"],
  properties: { version: { const: 1 }, id: { type: "integer", minimum: 0 }, type: { const: "response" }, success: { type: "boolean" }, payload: {},
    error: { type: "object", required: ["code", "message"], additionalProperties: false,
      properties: { code: { type: "string" }, message: { type: "string" } } } },
  if: { properties: { success: { const: true } } }, then: { required: ["payload"], not: { required: ["error"] } },
  else: { required: ["error"], not: { required: ["payload"] } },
};
const spec = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Voice server protocol v1",
  $defs: { websocketRequest: { oneOf: inbound }, websocketResponse: response,
    websocketEvent: { type: "object", additionalProperties: false, required: ["version", "type", "payload"],
      properties: { version: { const: 1 }, type: { type: "string", pattern: "^[a-z]+\\.[a-zA-Z]+$" }, payload: {} } },
    ...httpBodies },
};
await Bun.write(new URL("../../docs/protocol-v1.schema.json", import.meta.url).pathname, JSON.stringify(spec, null, 2) + "\n");
