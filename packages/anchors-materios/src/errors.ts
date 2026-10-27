export class MateriosConnectionError extends Error {
  override readonly name = "MateriosConnectionError";

  constructor(
    readonly code: "connect-timeout" | "connect-failed",
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`Materios connection ${code === "connect-timeout" ? "timed out" : "failed"} (budget ${timeoutMs} ms)`, options);
  }
}

export type MateriosSubmissionErrorCode = "not-landed" | "inclusion-unknown" | "dispatch";

export class MateriosSubmissionError extends Error {
  override readonly name = "MateriosSubmissionError";
  readonly safeToResubmit: boolean;

  constructor(
    readonly code: MateriosSubmissionErrorCode,
    readonly id: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.safeToResubmit = code === "not-landed";
  }
}
