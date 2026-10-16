import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("./install-compact.sh", import.meta.url));

test("requires one destination argument", () => {
  const result = spawnSync("bash", [installer], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("rejects a corrupted release archive before extraction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orynq-compact-test-"));
  try {
    await writeFile(join(directory, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    destination="$1"
  fi
  shift
done
printf 'corrupted release archive' > "$destination"
`, { mode: 0o755 });
    const destination = join(directory, "compiler");
    const result = spawnSync("bash", [installer, destination], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(existsSync(destination), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the release download fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orynq-compact-test-"));
  try {
    await writeFile(join(directory, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o755 });
    const destination = join(directory, "compiler");
    const result = spawnSync("bash", [installer, destination], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    assert.equal(result.status, 22);
    assert.equal(existsSync(destination), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
