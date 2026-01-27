/**
 * Verify TypeScript implementation matches test vectors.
 * Run with: npx tsx scripts/verify-hash-vectors.ts
 *
 * This script validates that the TypeScript canonical JSON and SHA256
 * implementations produce outputs that match the test vectors.
 *
 * IMPORTANT: This is a RELEASE GATE requirement. This script must pass
 * before any release.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { canonicalize, sha256StringHex } from "../packages/core/src/utils/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vector {
  name: string;
  description?: string;
  input: unknown;
  canonical: string;
  sha256: string;
}

interface VectorFile {
  description: string;
  version: string;
  generated: string;
  vectors: Vector[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fixturesPath = join(import.meta.dirname ?? __dirname, "..", "fixtures", "hash-vectors.json");
  const vectors: VectorFile = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  let passed = 0;
  let failed = 0;

  console.log("Verifying TypeScript implementation against test vectors...\n");

  for (const vector of vectors.vectors) {
    const actualCanonical = canonicalize(vector.input);
    const actualHash = await sha256StringHex(actualCanonical);

    const canonicalMatch = actualCanonical === vector.canonical;
    const hashMatch = actualHash === vector.sha256;

    if (canonicalMatch && hashMatch) {
      console.log(`[PASS] ${vector.name}`);
      passed++;
    } else {
      console.log(`[FAIL] ${vector.name}`);
      if (!canonicalMatch) {
        console.log(`   Canonical mismatch:`);
        console.log(`     Expected: ${vector.canonical}`);
        console.log(`     Actual:   ${actualCanonical}`);
      }
      if (!hashMatch) {
        console.log(`   Hash mismatch:`);
        console.log(`     Expected: ${vector.sha256}`);
        console.log(`     Actual:   ${actualHash}`);
      }
      failed++;
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\nVERIFICATION FAILED - Release gate not passed!");
    process.exit(1);
  }

  console.log("\nVERIFICATION PASSED - TypeScript implementation is correct.");
}

main().catch((err) => {
  console.error("Error verifying vectors:", err);
  process.exit(1);
});
