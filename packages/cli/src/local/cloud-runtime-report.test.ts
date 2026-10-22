import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@varveai/adit-core";
import type { CloudClient } from "@varveai/adit-cloud";
import { collectLocalRuntimeReport, sendLocalRuntimeReport } from "./cloud-runtime-report.js";

let root:string,store:LocalStore;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"adit-runtime-report-"));store=new LocalStore(join(root,"state"));});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
const credentials={clientId:"test",serverUrl:"http://localhost:3000",accessToken:"private-token",refreshToken:"",expiresAt:""};
it("reports the running CLI and registered sources without requiring legacy hooks or exposing local paths",()=>{
  const workspace=store.saveWorkspace({path:root,providers:["codex","cursor"],repositories:[]});
  const report=collectLocalRuntimeReport(store,workspace);
  expect(report).toMatchObject({schemaVersion:1,source:"cli",projectId:workspace.id,platforms:["codex","cursor"]});
  expect(report.components).toEqual([{name:"cli",version:report.version,evidence:"running"}]);
  expect(report.checks.find(check=>check.name==="Database")?.ok).toBe(true);
  expect(JSON.stringify(report)).not.toContain(root);
  expect(report.checks.some(check=>/hook|manifest/i.test(check.name))).toBe(false);
});
it("returns the existing upgrade response and treats failed diagnostics as optional",async()=>{
  const workspace=store.saveWorkspace({path:root,providers:["codex"],repositories:[]});
  const upgrade={needsAttention:false,state:"current",currentVersion:"0.0.0",latest:null,impacts:[]};
  const post=vi.fn().mockResolvedValue({upgrade});
  const options={client:{post} as Pick<CloudClient,"post">};
  expect(await sendLocalRuntimeReport(store,workspace,credentials,options)).toEqual({upgrade});
  expect(post.mock.calls[0][0]).toBe("/api/sync/runtime");
  expect(JSON.stringify(post.mock.calls)).not.toContain(credentials.accessToken);
  post.mockRejectedValue(new Error("network unavailable"));
  expect((await sendLocalRuntimeReport(store,workspace,credentials,options)).runtimeReportError).toContain("next sync");
  post.mockClear();
  expect((await sendLocalRuntimeReport(store,workspace,credentials,{...options,collect:()=>{throw new Error("read unavailable");}})).runtimeReportError).toContain("next sync");
  expect(post).not.toHaveBeenCalled();
});
