import { afterAll, beforeAll, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as midnight from "@fluxpointstudios/orynq-sdk-anchors-midnight";

const root = mkdtempSync(join(tmpdir(), "receipt-old-peer-")), mcp = join(root,"mcp"), cli = join(root,"quickstart");
const mcpSource = fileURLToPath(new URL("../..",import.meta.url)), cliSource = fileURLToPath(new URL("../../../quickstart",import.meta.url));
beforeAll(() => {
  for (const path of [join(mcp,"dist"),join(cli,"dist"),join(cli,"bin")]) mkdirSync(path,{recursive:true});
  for (const path of [mcp,cli]) writeFileSync(join(path,"package.json"),JSON.stringify({type:"module"}));
  copyFileSync(join(mcpSource,"dist/index.js"),join(mcp,"dist/index.js"));
  copyFileSync(join(cliSource,"dist/midnight.js"),join(cli,"dist/midnight.js"));
  copyFileSync(join(cliSource,"bin/orynq.mjs"),join(cli,"bin/orynq.mjs"));
  const manifest = JSON.parse(readFileSync(join(mcpSource,"package.json"),"utf8"));
  for (const name of Object.keys(manifest.dependencies)) {
    const target=join(root,"node_modules",name); mkdirSync(dirname(target),{recursive:true}); symlinkSync(realpathSync(join(mcpSource,"node_modules",name)),target);
  }
  const peer=join(root,"node_modules/@fluxpointstudios/orynq-sdk-anchors-midnight"); mkdirSync(peer,{recursive:true});
  writeFileSync(join(peer,"package.json"),JSON.stringify({type:"module",version:"0.2.1",exports:"./index.mjs"}));
  const names=Object.keys(midnight).filter(name=>name!=="discoverReceiptProof");
  writeFileSync(join(peer,"index.mjs"),`export {${names.join(",")}} from ${JSON.stringify(fileURLToPath(new URL("../../../anchors-midnight/dist/index.js",import.meta.url)))};\n`);
});
afterAll(()=>rmSync(root,{recursive:true,force:true}));

it("the built CLI gives an upgrade message when the older optional peer lacks discovery",()=>{
  const result=spawnSync(process.execPath,[join(cli,"bin/orynq.mjs"),"verify","midnight-receipt","00".repeat(32),"--genesis","01".repeat(32),"--content-hash","02".repeat(32),"--certificate-hash","03".repeat(32),"--gateway","http://127.0.0.1:9","--rpc","http://127.0.0.1:9"],{encoding:"utf8",timeout:30_000});
  expect(result.status).toBe(1); expect(result.stderr).toContain("version 0.3.0 or newer"); expect(result.stderr).not.toContain(root);
});
it("the built MCP starts with the older peer and refuses only the unsupported receipt feature",async()=>{
  const client=new Client({name:"old-peer-test",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(mcp,"dist/index.js")],stderr:"ignore"}));
  try {
    expect((await client.listTools()).tools.map(tool=>tool.name)).toContain("verify_midnight_anchor");
    const result=await client.callTool({name:"verify_midnight_receipt",arguments:{receiptId:"00".repeat(32),materiosGenesis:"01".repeat(32),contentHash:"02".repeat(32),certificateHash:"03".repeat(32)}});
    expect(result.isError).toBe(true); expect((result.content as {text:string}[])[0]!.text).toContain("version 0.3.0 or newer");
  } finally {await client.close();}
});
it("the built CLI keeps its existing verifier usable with that peer",()=>{
  const result=spawnSync(process.execPath,[join(cli,"bin/orynq.mjs"),"verify","midnight","00".repeat(32),"--network","preprod","--indexer","http://127.0.0.1:9","--rpc","http://127.0.0.1:9","--json"],{encoding:"utf8",timeout:30_000});
  expect(result.status).toBe(1); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout).status).toBe("invalid");
});
