import { loadConfig, OpenClawRecorder } from "@fluxpointstudios/orynq-sdk-recorder-openclaw";

export async function start(opts: { config: string }) {
  const cfg = await loadConfig(opts.config);
  const rec = new OpenClawRecorder(cfg);

  console.log("Orynq OpenClaw recorder running");
  console.log(`   Config: ${opts.config}`);
  console.log(`   OpenClaw root: ${cfg.openclawRoot}`);
  console.log(`   Out: ${cfg.outDir}`);
  console.log("");

  await rec.runForever();
}
