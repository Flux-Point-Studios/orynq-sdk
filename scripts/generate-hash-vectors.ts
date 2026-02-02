/**
 * Generate hash vectors and update fixtures/hash-vectors.json with actual values.
 * Run with: npx tsx scripts/generate-hash-vectors.ts
 *
 * This script is the source of truth for cross-language hash compatibility.
 * It reads the template vectors file and computes the actual canonical JSON
 * and SHA256 hash values using the TypeScript implementation.
 *
 * IMPORTANT: This is a RELEASE GATE requirement. Both TypeScript and Python
 * implementations must produce identical outputs for all vectors.
 */
import { writeFileSync, readFileSync } from "fs";
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

  // Read existing vectors
  const existing: VectorFile = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  console.log("Generating hash vectors from TypeScript implementation...\n");

  // Update each vector with computed values
  const updatedVectors: Vector[] = [];

  for (const vector of existing.vectors) {
    const canonical = canonicalize(vector.input);
    const hash = await sha256StringHex(canonical);

    updatedVectors.push({
      ...vector,
      canonical,
      sha256: hash,
    });

    console.log(`${vector.name}:`);
    console.log(`  Input: ${JSON.stringify(vector.input)}`);
    console.log(`  Canonical: ${canonical}`);
    console.log(`  SHA256: ${hash.slice(0, 16)}...`);
    console.log();
  }

  // Write updated file
  const output: VectorFile = {
    description: existing.description,
    version: existing.version,
    generated: new Date().toISOString(),
    vectors: updatedVectors,
  };

  writeFileSync(fixturesPath, JSON.stringify(output, null, 2) + "\n");

  console.log("=".repeat(50));
  console.log(`Generated ${updatedVectors.length} test vectors`);
  console.log(`Written to: ${fixturesPath}`);
}

main().catch((err) => {
  console.error("Error generating vectors:", err);
  process.exit(1);
});
