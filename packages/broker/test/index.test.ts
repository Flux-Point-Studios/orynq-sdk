import { expect, it } from "vitest";
import * as broker from "../src/index.js";

it("exports the framing, decoding and schema surface and nothing else", () => {
  expect(Object.keys(broker).sort()).toEqual([
    "FrameDecoder",
    "FrameError",
    "IDLE_TIMEOUT_MS",
    "MAX_FRAME_BYTES",
    "METHOD_PARAMS",
    "RpcError",
    "SCHEMA_RULES",
    "decodeRequest",
    "encodeFrame",
    "jsonToCbor",
    "jsonToDcbor",
    "parseJsonPayload",
    "schemaRules",
    "serveConnection",
  ]);
});
