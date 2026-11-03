export type BrokerWireErrorCode = "PEER_INVALID";

// Messages name the failing field and never quote the input.
export class BrokerWireError extends Error {
  readonly code: BrokerWireErrorCode;
  readonly field: string;

  constructor(code: BrokerWireErrorCode, field: string) {
    super(field === "peer" ? "peer is invalid" : `peer field ${field} is invalid`);
    this.name = "BrokerWireError";
    this.code = code;
    this.field = field;
  }
}
