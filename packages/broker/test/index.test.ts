import { expect, it, vi } from "vitest";
import * as broker from "../src/index.js";

const { loads } = vi.hoisted(() => ({ loads: [] as string[] }));

// The Windows package's root entry loads koffi; its ./frontend entry does not.
vi.mock("@fluxpointstudios/orynq-sdk-credential-broker-windows", () => {
  loads.push("credential-broker-windows");
  return {};
});

it("hosts the Windows sidecar without loading the Windows package's native bindings", () => {
  expect(broker.startWindowsFrontend).toBeTypeOf("function");
  expect(loads).toEqual([]);
});

it("exports the broker, host, client, framing, decoding and schema surface and nothing else", () => {
  expect(Object.keys(broker).sort()).toEqual([
    "Broker",
    "BrokerReplyError",
    "FrameDecoder",
    "FrameError",
    "IDLE_TIMEOUT_MS",
    "MAX_FRAME_BYTES",
    "MAX_REQUEST_VALUES",
    "METHOD_PARAMS",
    "RPC_ERRORS",
    "RpcError",
    "SCHEMA_RULES",
    "array",
    "bytes",
    "choice",
    "connectBroker",
    "decodeRequest",
    "encodeFrame",
    "jsonToCbor",
    "jsonToDcbor",
    "literal",
    "map",
    "optional",
    "parseJsonPayload",
    "schemaRules",
    "serveConnection",
    "serveMux",
    "startLinuxFrontend",
    "startWindowsFrontend",
    "text",
    "uint",
  ]);
});

it("lets code outside the package register an effect kind", () => {
  const rules = broker.schemaRules({
    "test.echo": { params: broker.map({ message: broker.text(64, { minBytes: 1 }) }), effect: broker.bytes(1, 64) },
  });
  const params = { kind: "test.echo", params: { message: "hi" }, mandates: ["11".repeat(32)] };
  expect(() => broker.jsonToDcbor(params, rules["intent-submit-params"])).not.toThrow();
  expect(() => broker.jsonToDcbor(params, broker.SCHEMA_RULES["intent-submit-params"])).toThrow(broker.RpcError);
});
