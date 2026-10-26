import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("prints complete receipt verification hashes separately from the trace roots", () => {
  const root = mkdtempSync(join(tmpdir(), "quickstart-cli-"));
  const contentHash = `0x${"11".repeat(32)}`, rootHash = `0x${"22".repeat(32)}`, certHash = `0x${"33".repeat(32)}`;
  try {
    mkdirSync(join(root, "bin")); mkdirSync(join(root, "dist"));
    copyFileSync(new URL("../../bin/orynq.mjs", import.meta.url), join(root, "bin/orynq.mjs"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "dist/index.js"), `export async function bootstrapAndTrace() { return ${JSON.stringify({
      elapsedMs: 1, receiptId: "receipt", blockHash: "block", contentHash, rootHash, certHash,
      bundle: { rootHash: "trace-root", merkleRoot: "trace-merkle" },
      urls: { blobStatus: "blob", explorer: "explorer", chainInfo: "info", gatewayHealth: "health" },
    })}; }`);
    const output = execFileSync(process.execPath, [join(root, "bin/orynq.mjs"), "trace"], { encoding: "utf8" });
    expect(output).toContain(`contentHash   ${contentHash}`);
    expect(output).toContain(`baseRootHash  ${rootHash}`);
    expect(output).toContain(`certificateHash ${certHash}`);
    expect(output).toContain("traceRootHash trace-root");
    expect(output).toContain("traceMerkleRoot trace-merkle");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
