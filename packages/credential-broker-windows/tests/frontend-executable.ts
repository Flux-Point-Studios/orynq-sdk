import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const manifest = fileURLToPath(new URL("../native/Cargo.toml", import.meta.url));

execFileSync("cargo", ["build", "--locked", "--quiet", "--manifest-path", manifest], { stdio: "inherit" });

export const FRONTEND_EXECUTABLE = fileURLToPath(new URL("../native/target/debug/orynq-pipe-frontend.exe", import.meta.url));
