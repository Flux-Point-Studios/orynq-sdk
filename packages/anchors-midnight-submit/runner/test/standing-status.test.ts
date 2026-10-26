import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStandingStatus } from "../standing-status.js";
import { syncWithCheckpoints } from "../../src/sync.js";
import type { OperatorWallet } from "../../src/wallet.js";
const roots: string[] = [];
const scope={mode:"anchor" as const,network:"preprod" as const,genesis:"01".repeat(32),registry:"02".repeat(32),author:"03".repeat(32),policyDigest:"04".repeat(32),runtimeSpecVersion:1000300};
const root=()=>{const path=mkdtempSync(join(tmpdir(),"standing-status-"));roots.push(path);return path;};
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
it("retains cap episodes across missed polls and service restarts without repeating an active episode",()=>{
  const directory=root();let now=1000;
  let status=openStandingStatus(directory,scope,()=>now);
  status.hold("controller","dust-cap");expect(status.read().cap.sequence).toBe(1);
  status.record("follower","success",{height:10});status.hold("controller","dust-cap");expect(status.read().cap.sequence).toBe(1);
  now+=1000;status=openStandingStatus(directory,scope,()=>now);
  status.hold("controller","dust-cap");expect(status.read().cap.sequence).toBe(1);
  status.record("controller","success",{state:"idle"});now+=1000;status.hold("controller","dust-cap");
  expect(status.read().cap).toMatchObject({sequence:2,active:true,lastAt:now});
});
it("keeps the controller's operation start and meaningful progress separate from a healthy follower",()=>{
  let now=1000;const status=openStandingStatus(root(),scope,()=>now);
  status.record("controller","start");now+=120_000;
  status.record("follower","success",{height:42});const snapshot=status.read();
  expect(snapshot.updatedAt).toBe(now);expect(snapshot.loops.controller).toMatchObject({busy:true,operationStartedAt:1000,lastCompletedAt:null});
  expect(snapshot.loops.follower).toMatchObject({busy:false,lastCompletedAt:now,lastProgressAt:now});
  status.record("controller","success",{state:"pending",txHash:"04".repeat(32)});const first=status.read().loops.controller.lastProgressAt;
  now+=15_000;status.record("controller","success",{state:"pending",txHash:"04".repeat(32)});
  expect(status.read().loops.controller.lastProgressAt).toBe(first);expect(status.read().loops.controller.lastCompletedAt).toBe(now);
});
it("refuses a mismatched retained monitoring scope and preserves the existing cap history",()=>{
  const directory=root(),status=openStandingStatus(directory,scope,()=>1000);status.hold("controller","dust-cap");
  expect(()=>openStandingStatus(directory,{...scope,author:"ff".repeat(32)},()=>2000)).toThrow(/scope/);
  expect(openStandingStatus(directory,scope,()=>3000).read().cap.sequence).toBe(1);
});
it.each([{sequence:0,active:true,lastAt:null},{sequence:1,active:false,lastAt:null},{sequence:0,active:false,lastAt:1},{sequence:1,active:true,lastAt:1,extra:true}])("refuses corrupt retained cap history %j",cap=>{
  const directory=root();openStandingStatus(directory,scope,()=>1000);
  const path=join(directory,"status.json"),saved=JSON.parse(readFileSync(path,"utf8"));saved.cap=cap;writeFileSync(path,JSON.stringify(saved),{mode:0o600});
  expect(()=>openStandingStatus(directory,scope,()=>2000)).toThrow(/cap history/);
});
it("refuses retained monitoring state that is not JSON without quoting it",()=>{
  const directory=root();writeFileSync(join(directory,"status.json"),"abandon ability able",{mode:0o600});
  let thrown:unknown;try{openStandingStatus(directory,scope);}catch(error){thrown=error;}
  expect((thrown as Error).message).toBe("Standing retained monitoring state is not JSON");
  expect((thrown as Error).cause).toBeUndefined();
});
it("refreshes a sync heartbeat without resetting the phase's original start",async()=>{
  let now=1000;const status=openStandingStatus(root(),scope,()=>now);status.phase("wallet-sync");now+=180_000;
  const progress={applied:1,highest:2,connected:true};
  const wallet={waitForSync:async()=>{},progress:async()=>({shielded:progress,unshielded:progress,dust:progress,synced:true}),saveState:async()=>({saved:true})} as unknown as OperatorWallet;
  await syncWithCheckpoints(wallet,{timeoutMs:1000,progressMs:100,checkpointMs:100,write:()=>{status.phase("wallet-sync");}});
  expect(status.read()).toMatchObject({phase:"wallet-sync",updatedAt:now,phaseStartedAt:1000});
  status.phase("running");expect(status.read().phaseStartedAt).toBe(now);
});
it("keeps lifetime financial history out of bounded process status",()=>{
  const status=openStandingStatus(root(),scope,()=>1000);
  const historical={chainTime:1000,observations:[],confirmations:Array.from({length:15000},(_,n)=>({txHash:n.toString(16).padStart(64,"0"),fee:10000000000000n,confirmedAt:0,validUntil:1,state:"absent"}))};
  expect(()=>Reflect.apply(status.sample,status,[{head:null},historical])).not.toThrow();
  expect(status.read()).not.toHaveProperty("accounting");status.phase("stopped");
});
