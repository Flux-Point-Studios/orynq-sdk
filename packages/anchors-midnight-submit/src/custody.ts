// True in a process that carries Claude Code's environment (CLAUDECODE or a CLAUDE_CODE_*
// variable): an agent session that starts a script or loads a key as it is. It is an accident
// guard, not a boundary: code running as deci can drop those variables.
export const agentDriven = (env: NodeJS.ProcessEnv = process.env) => Object.keys(env).some((name) => name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_"));
