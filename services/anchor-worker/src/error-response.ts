/**
 * Failure body for POST /anchor.
 *
 * `network` and `label` are present on failure as well as success. A client
 * that cannot see the network in a failure has to fall back on its own
 * default, and a default is a guess: 224 preprod failures were recorded as
 * mainnet that way, which priced a funding decision against the wrong chain.
 */
export interface AnchorErrorBody {
  success: false;
  error: string;
  network: string;
  label: number;
}

export function anchorErrorBody(
  error: unknown,
  network: string,
  label: number
): AnchorErrorBody {
  return {
    success: false,
    error: error instanceof Error ? error.message : "Unknown error occurred",
    network,
    label,
  };
}
