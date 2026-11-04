// Connects to the socket named in argv and hands the connected socket to the parent over IPC, then
// exits: the connection outlives the process that made it.
import { createConnection } from "node:net";

const socket = createConnection({ path: process.argv[2] });
socket.once("connect", () => {
  process.send("connected", socket, { keepOpen: false }, () => process.exit(0));
});
socket.once("error", error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
