import { Command } from "commander";
import { install } from "./commands/install.js";
import { start } from "./commands/start.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { logs } from "./commands/logs.js";
import { startService, stopService, restartService } from "./commands/service.js";
import { uninstall } from "./commands/uninstall.js";
import { configPath } from "./platform/paths.js";

const program = new Command();

program
  .name("orynq-openclaw")
  .description("Install OpenClaw + attach Orynq process-trace anchoring recorder (local-first)")
  .version("0.1.0");

program.command("install")
  .description("Install Orynq OpenClaw recorder config and optionally as a service")
  .option("--openclaw-root <path>", "Path to OpenClaw root directory")
  .option("--out-dir <path>", "Output directory for recorder artifacts")
  .option("--service", "Install as background daemon (systemd/launchd/Task Scheduler)")
  .action(async (opts) => install({ openclawRoot: opts.openclawRoot, outDir: opts.outDir, service: !!opts.service }));

program.command("start")
  .description("Run the recorder in foreground")
  .option("--config <path>", "Config path", configPath())
  .action(async (opts) => start({ config: opts.config }));

program.command("doctor")
  .description("Check configuration and environment")
  .option("--config <path>", "Config path", configPath())
  .action(async (opts) => doctor({ config: opts.config }));

program.command("status")
  .description("Show daemon status with fallback checks")
  .action(async () => status());

program.command("logs")
  .description("View logs (journalctl on Linux, file logs elsewhere)")
  .option("-f, --follow", "Follow logs")
  .action(async (opts) => logs({ follow: !!opts.follow }));

program.command("start-service")
  .description("Start the background service")
  .action(async () => startService());

program.command("stop-service")
  .description("Stop the background service")
  .action(async () => stopService());

program.command("restart-service")
  .description("Restart the background service")
  .action(async () => restartService());

program.command("uninstall")
  .description("Remove the recorder")
  .option("--service", "Remove background daemon")
  .option("--purge", "Delete config directory")
  .action(async (opts) => uninstall({ service: !!opts.service, purge: !!opts.purge }));

program.parse(process.argv);
