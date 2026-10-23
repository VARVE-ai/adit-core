import { expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { SKILLS } from "./commands/skills.js";
import { CLI_VERSION } from "./version.js";
const exec=promisify(execFile);

it.skipIf(process.getuid?.()===0)("runs npm postinstall to update Skills and replace the daemon, preserving it on a later Skill failure",async()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-install-integration-")),data=join(root,"data"),home=join(root,"home"),preload=join(root,"home.cjs");
  // Redirect only these child processes; no user configuration or environment
  // variables such as HOME are changed. The daemon inherits this preload.
  writeFileSync(preload,`require('node:os').homedir=()=>${JSON.stringify(home)};require('node:module').syncBuiltinESMExports();`);
  const env={...process.env,ADIT_LOCAL_DATA_DIR:data,APPDATA:join(root,"appdata"),XDG_CONFIG_HOME:join(root,"config"),NODE_OPTIONS:`${process.env.NODE_OPTIONS||""} --require ${JSON.stringify(preload)}`};
  // A temporary npm package uses the real published hook and compiled setup.
  // Its prefix/cache/home are isolated; no global user installation is replaced.
  const packageDir=join(root,"package");mkdirSync(join(packageDir,"dist"),{recursive:true});
  copyFileSync(fileURLToPath(new URL("../install-skill.cjs",import.meta.url)),join(packageDir,"install-skill.cjs"));
  writeFileSync(join(packageDir,"dist/install-skills.js"),`await import(${JSON.stringify(new URL("../dist/install-skills.js",import.meta.url).href)});`);
  let version=0;
  const setup=async()=>{
    writeFileSync(join(packageDir,"package.json"),JSON.stringify({name:"adit-installation-test",version:`1.0.${++version}`,type:"module",scripts:{postinstall:"node install-skill.cjs"}}));
    const installEnv={...env,CI:"false",ADIT_DEFER_INSTALL_SETUP:"",npm_config_ignore_scripts:"false",npm_config_foreground_scripts:"true"};
    // Windows npm is a .cmd shim; invoke its JavaScript entry without a shell.
    const npmCli=process.platform==="win32"?[dirname(process.execPath),...(process.env.PATH||"").split(delimiter)]
      .map(directory=>join(directory,"node_modules/npm/bin/npm-cli.js")).find(existsSync):undefined;
    if(process.platform==="win32"&&!npmCli)throw new Error("Cannot locate npm's JavaScript entry for the installation test");
    const npm=(args:string[])=>exec(npmCli?process.execPath:"npm",npmCli?[npmCli,...args]:args,{env:installEnv,timeout:30000,windowsHide:true});
    const packed=await npm(["pack",packageDir,"--ignore-scripts","--json","--pack-destination",root,"--cache",join(root,"cache")]);
    const tarball=join(root,JSON.parse(packed.stdout)[0].filename);
    return npm(["install","--global","--prefix",join(root,"prefix"),"--cache",join(root,"cache"),"--no-audit","--no-fund",tarball]);
  };
  const cli=(...args:string[])=>exec(process.execPath,[fileURLToPath(new URL("../dist/index.js",import.meta.url)),...args],{env,timeout:30000});
  const info=()=>JSON.parse(readFileSync(join(data,"daemon.json"),"utf8")) as {url:string;instance:string;token:string};
  try{
    expect((await setup()).stdout).toContain("background service started");
    const original=info();
    const health=await fetch(original.url+"/health").then(r=>r.json());
    expect(health).toMatchObject({version:CLI_VERSION,instance:original.instance});
    const state=await fetch(original.url+"/api/local/state",{headers:{authorization:`Bearer ${original.token}`}}).then(r=>r.json()) as {startup:{enabled:boolean};workspaces:unknown[]};
    expect(state.startup.enabled).toBe(true);expect(state.workspaces).toEqual([]);
    const directory=join(home,".agents/skills/adit-history"),old="previous managed Skill";
    writeFileSync(join(directory,"SKILL.md"),old);
    writeFileSync(join(directory,".adit-managed.json"),JSON.stringify({owner:"adit",sha256:createHash("sha256").update(old).digest("hex")}));
    expect((await setup()).stdout).toContain("background service restarted");
    const current=info();expect(current.instance).not.toBe(original.instance);expect(current.url).toBe(original.url);
    for(const base of [".agents",".claude"])for(const skill of SKILLS)expect(readFileSync(join(home,base,"skills",skill.name,"SKILL.md"),"utf8")).toBe(skill.content);
    renameSync(join(home,".agents"),join(home,"agents-backup"));writeFileSync(join(home,".agents"),"blocked directory");
    await expect(setup()).rejects.toMatchObject({code:1,stderr:expect.stringContaining("Skill installation is incomplete")});
    expect(info().instance).toBe(current.instance);
    expect((await fetch(current.url+"/health")).status).toBe(200);
  }finally{
    await cli("daemon","stop");
    rmSync(root,{recursive:true,force:true});
  }
},60000);
