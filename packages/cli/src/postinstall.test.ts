import { afterEach, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const roots: string[] = [];
afterEach(() => { for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true}); });
function fixture(options: { source?: boolean; missing?: boolean; failure?: boolean; root?: boolean } = {}) {
  const root=mkdtempSync(join(tmpdir(),"adit-postinstall-"));roots.push(root);
  copyFileSync(fileURLToPath(new URL("../install-skill.cjs",import.meta.url)),join(root,"install-skill.cjs"));
  writeFileSync(join(root,"package.json"),JSON.stringify({type:"module",dependencies:options.source?{core:"workspace:*"}:{core:"1.0.0"}}));
  writeFileSync(join(root,"user.cjs"),`process.getuid=process.geteuid=()=>${options.root?0:501};`);
  if(!options.missing){
    mkdirSync(join(root,"dist"));
    writeFileSync(join(root,"dist/install-skills.js"),`import {writeFileSync} from 'node:fs';writeFileSync(new URL('../called.json',import.meta.url),JSON.stringify(process.argv.slice(2)));process.exitCode=${options.failure?1:0};`);
  }
  const run=(extra: NodeJS.ProcessEnv={})=>spawnSync(process.execPath,["--require",join(root,"user.cjs"),join(root,"install-skill.cjs")],{encoding:"utf8",env:{...process.env,CI:"false",ADIT_DEFER_INSTALL_SETUP:"",...extra}});
  return {root,run,called:()=>existsSync(join(root,"called.json"))?JSON.parse(readFileSync(join(root,"called.json"),"utf8")):null};
}
it("runs complete user setup for a published package",()=>{const f=fixture();expect(f.run().status).toBe(0);expect(f.called()).toEqual([]);});
it("propagates setup failure to the package manager",()=>{const f=fixture({failure:true});expect(f.run().status).toBe(1);});
it("rejects a published package missing the setup entry",()=>{const f=fixture({missing:true});const r=f.run();expect(r.status).toBe(1);expect(r.stderr).toContain("missing its installer");});
it("allows an unbuilt workspace and keeps built workspace hooks limited to Skills",()=>{
  expect(fixture({source:true,missing:true}).run().status).toBe(0);
  const f=fixture({source:true});expect(f.run().status).toBe(0);expect(f.called()).toEqual(["--skills-only"]);
});
it("defers hooks during adit update so setup is run only once",()=>{const f=fixture();expect(f.run({ADIT_DEFER_INSTALL_SETUP:"1"}).status).toBe(0);expect(f.called()).toBeNull();});
it("does not run user setup during CI installation, including root containers",()=>{const f=fixture({root:true});expect(f.run({CI:"true"}).status).toBe(0);expect(f.called()).toBeNull();});
it("reports root setup as incomplete instead of silently installing in the wrong account",()=>{const f=fixture({root:true});const r=f.run();expect(r.status).toBe(1);expect(f.called()).toBeNull();expect(r.stderr).toContain("without sudo");});
