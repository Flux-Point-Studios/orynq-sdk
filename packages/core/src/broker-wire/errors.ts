export type BrokerWireErrorCode = "PEER_INVALID" | "MUX_LENGTH" | "MUX_KIND" | "MUX_READY" | "MUX_FRAME" | "MUX_CLOSE";

const MUX_MESSAGES: Readonly<Record<Exclude<BrokerWireErrorCode, "PEER_INVALID">, string>> = {
  MUX_LENGTH: "mux message length is outside 9 to 9 + 16 MiB",
  MUX_KIND: "mux message kind is unknown",
  MUX_READY: "mux READY must carry conn 0 and no payload",
  MUX_FRAME: "mux FRAME must carry 1 byte to 16 MiB",
  MUX_CLOSE: "mux CLOSE must carry no payload",
};

// Messages come from a fixed table or name the failing peer field; they never quote the input.
export class BrokerWireError extends Error {
  readonly code: BrokerWireErrorCode;
  readonly field: string | undefined;

  constructor(code: "PEER_INVALID", field: string);
  constructor(code: Exclude<BrokerWireErrorCode, "PEER_INVALID">);
  constructor(code: BrokerWireErrorCode, field?: string) {
    super(code !== "PEER_INVALID" ? MUX_MESSAGES[code] : field === "peer" ? "peer is invalid" : `peer field ${field} is invalid`);
    this.name = "BrokerWireError";
    this.code = code;
    this.field = field;
  }
}
