import { readFileSync } from "node:fs";

// The hard limits every approval runs under, as limits.json holds them: changing one is a
// reviewed change to that file. README.md says what each one bounds.
export interface Limits {
  network: string;
  payer: string;
  maxFeeDustPerTransaction: string;
  maxDustPer24Hours: string;
  maxApprovalHours: number;
  maxConfirmationsPerTransaction: number;
  deploy: { action: string; authority: string; verifierKeys: Record<string, string> };
  anchors: { action: string; authorKeys: string[]; maxEntriesPerApproval: number };
}

export const LIMITS: Readonly<Limits> = JSON.parse(readFileSync(new URL("./limits.json", import.meta.url), "utf8"));
