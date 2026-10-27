#!/usr/bin/env node
import chalk from "chalk";
import { createProgram } from "./index.js";

createProgram().parseAsync(process.argv).catch((error) => {
  console.error(chalk.red("Fatal error:"), error instanceof Error ? error.message : String(error));
  process.exit(1);
});
