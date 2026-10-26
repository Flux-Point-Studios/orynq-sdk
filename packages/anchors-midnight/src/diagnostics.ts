// Public verifier diagnostics may contain source data. Keep each field printable and bounded.
export const MAX_CHECK_DETAIL = 300;
export function boundedDetail(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/gu, "?").slice(0, MAX_CHECK_DETAIL).replace(/[\uD800-\uDBFF]$/u, "?");
}
export const isSourceHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isSourceHeight = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
