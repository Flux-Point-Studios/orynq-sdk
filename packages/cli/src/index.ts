import { Command } from "commander";
import { version } from "../package.json";
import {
  registerInvoiceCommand,
  registerPayCommand,
  registerStatusCommand,
  registerBalanceCommand,
  registerCallCommand,
  registerTestX402Command,
} from "./commands/index.js";

export const VERSION = version;

export function createProgram(): Command {
  const program = new Command();

  program
    .name("poi")
    .description("orynq-sdk CLI - Testing tool for 402 payment flows")
    .version(VERSION);

  registerInvoiceCommand(program);
  registerPayCommand(program);
  registerStatusCommand(program);
  registerBalanceCommand(program);
  registerCallCommand(program);
  registerTestX402Command(program);

  return program;
}
