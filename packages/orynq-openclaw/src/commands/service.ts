import { startServiceNow, stopServiceNow, restartServiceNow } from "../platform/services.js";

export async function startService() { await startServiceNow(); }
export async function stopService() { await stopServiceNow(); }
export async function restartService() { await restartServiceNow(); }
