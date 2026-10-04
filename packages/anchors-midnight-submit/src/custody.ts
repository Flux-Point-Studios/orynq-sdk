// True in a process an agent drives. A secret loaded or a confirmation typed there is reachable by
// the agent, so mainnet keys and mainnet confirmations refuse it.
export const agentDriven = (env: NodeJS.ProcessEnv = process.env) => Object.keys(env).some((name) => name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_"));
