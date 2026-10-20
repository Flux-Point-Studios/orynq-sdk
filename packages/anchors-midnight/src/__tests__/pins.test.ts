import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MIDNIGHT_PINS = {
  "@midnight-ntwrk/compact-runtime": "0.16.0",
  "@midnight-ntwrk/ledger-v8": "8.1.3",
  "@midnight-ntwrk/onchain-runtime-v3": "3.1.2",
  "@midnight-ntwrk/zkir-v2": "2.1.1",
};

// The wallet SDK 1.2.0 set (ledger 8) the submit package uses, exactly as npm resolves it.
const WALLET_SDK = {
  "@midnight-ntwrk/wallet-sdk-abstractions": "2.1.0",
  "@midnight-ntwrk/wallet-sdk-address-format": "3.1.2",
  "@midnight-ntwrk/wallet-sdk-capabilities": "3.3.1",
  "@midnight-ntwrk/wallet-sdk-dust-wallet": "4.2.0",
  "@midnight-ntwrk/wallet-sdk-facade": "4.1.0",
  "@midnight-ntwrk/wallet-sdk-hd": "3.0.3",
  "@midnight-ntwrk/wallet-sdk-indexer-client": "1.2.3",
  "@midnight-ntwrk/wallet-sdk-node-client": "1.1.2",
  "@midnight-ntwrk/wallet-sdk-prover-client": "1.2.2",
  "@midnight-ntwrk/wallet-sdk-runtime": "1.0.5",
  "@midnight-ntwrk/wallet-sdk-shielded": "3.0.2",
  "@midnight-ntwrk/wallet-sdk-unshielded-wallet": "3.1.0",
  "@midnight-ntwrk/wallet-sdk-utilities": "1.2.1",
};

describe("toolchain and dependency pins", () => {
  it("the root overrides force exactly the pinned Midnight packages", () => {
    const { pnpm } = JSON.parse(read("../../../../package.json"));
    for (const [name, version] of Object.entries(MIDNIGHT_PINS)) expect(pnpm.overrides[name]).toBe(version);
  });

  it("the lockfile resolves one copy of each pinned Midnight package and nothing from ledger 9", () => {
    const resolved = [...read("../../../../pnpm-lock.yaml").matchAll(/^ {2}\/(@midnight-ntwrk\/[^@\s]+)@([^:(\s]+)/gm)].map(
      ([, name, version]) => `${name}@${version}`,
    );
    expect(resolved.sort()).toEqual(Object.entries({ ...MIDNIGHT_PINS, ...WALLET_SDK }).map(([n, v]) => `${n}@${v}`).sort());
  });

  it("every workspace package names each Midnight package at exactly its pinned version", () => {
    const pinned: Record<string, string> = { ...MIDNIGHT_PINS, ...WALLET_SDK };
    const named: string[] = [];
    for (const group of ["packages", "services"]) {
      for (const dir of readdirSync(new URL(`../../../../${group}/`, import.meta.url))) {
        const path = `../../../../${group}/${dir}/package.json`;
        if (!existsSync(new URL(path, import.meta.url))) continue;
        const manifest: Record<string, Record<string, string> | undefined> = JSON.parse(read(path));
        for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
          for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
            if (!name.startsWith("@midnight-ntwrk/")) continue;
            named.push(name);
            expect(spec, `${group}/${dir} ${field} ${name}`).toBe(pinned[name]);
          }
        }
      }
    }
    expect(named).toContain("@midnight-ntwrk/onchain-runtime-v3");
  });

  it("every Compact build requires the compactc version the installer pins", () => {
    const version = /^version=(\S+)$/m.exec(read("../../../../tools/compactc/install.sh"))?.[1];
    expect(version).toBe("0.31.1");
    expect(read("../../contract/compile.sh")).toContain(`[ "$version" = ${version} ]`);
    expect(read("../../../midnight-prover/scripts/compile-circuits.mjs")).toContain(`version !== "${version}"`);
  });

  it("the committed contract was compiled by compactc 0.31.1 for language 0.23.0 and runtime 0.16.0", () => {
    const info = JSON.parse(read("../../contract/managed/compiler/contract-info.json"));
    expect([info["compiler-version"], info["language-version"], info["runtime-version"]]).toEqual(["0.31.1", "0.23.0", "0.16.0"]);
  });
});
