import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MIDNIGHT_PINS = {
  "@midnight-ntwrk/compact-runtime": "0.16.0",
  "@midnightntwrk/ledger-v8": "8.1.3",
  "@midnight-ntwrk/onchain-runtime-v3": "3.1.2",
  "@midnightntwrk/zkir-v2": "2.2.0",
  "@midnightntwrk/ledger-v9": "1.0.0",
};
const isMidnight = (name: string) => name.startsWith("@midnight-ntwrk/") || name.startsWith("@midnightntwrk/");

// The wallet SDK 2.0.0 set the submit package uses, exactly as npm resolves it.
const WALLET_SDK = {
  "@midnightntwrk/wallet-sdk-abstractions": "3.0.0",
  "@midnightntwrk/wallet-sdk-address-format": "4.0.0",
  "@midnightntwrk/wallet-sdk-capabilities": "4.0.0",
  "@midnightntwrk/wallet-sdk-dust-wallet": "5.0.0",
  "@midnightntwrk/wallet-sdk-facade": "5.0.0",
  "@midnightntwrk/wallet-sdk-hd": "4.0.0",
  "@midnightntwrk/wallet-sdk-indexer-client": "2.0.0",
  "@midnightntwrk/wallet-sdk-node-client": "2.0.0",
  "@midnightntwrk/wallet-sdk-prover-client": "2.0.0",
  "@midnightntwrk/wallet-sdk-runtime": "2.0.0",
  "@midnightntwrk/wallet-sdk-shielded": "4.0.0",
  "@midnightntwrk/wallet-sdk-unshielded-wallet": "4.0.0",
  "@midnightntwrk/wallet-sdk-utilities": "1.3.0",
};

describe("toolchain and dependency pins", () => {
  it("the root overrides force exactly the pinned Midnight packages", () => {
    const { pnpm } = JSON.parse(read("../../../../package.json"));
    for (const [name, version] of Object.entries(MIDNIGHT_PINS)) expect(pnpm.overrides[name]).toBe(version);
  });

  it("the lockfile resolves one copy of each pinned Midnight package, in either npm scope, and nothing else from either", () => {
    const resolved = [...read("../../../../pnpm-lock.yaml").matchAll(/^ {2}\/(@midnight-?ntwrk\/[^@\s]+)@([^:(\s]+)/gm)].map(
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
            if (!isMidnight(name)) continue;
            named.push(name);
            expect(spec, `${group}/${dir} ${field} ${name}`).toBe(pinned[name]);
          }
        }
      }
    }
    expect(named).toContain("@midnight-ntwrk/onchain-runtime-v3");
    expect(named).toContain("@midnightntwrk/ledger-v9");
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
