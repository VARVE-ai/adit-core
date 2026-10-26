import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore, LocalHistory, projectRepositories } from "@varveai/adit-core";
import { createAttributionSchema } from "../../../core/src/local-history/attribution-schema.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { CloudProjection, CloudSessionIndex, cloudFinalReply, cloudTurnUsage, createCloudSyncSchema, finalReply, syncKey, type CloudBaseline } from "./cloud-projection.js";
import { cloudPending } from "./cloud-pending.js";
import { LocalCloudSync } from "./cloud-sync.js";
import { loadCredentials, collectRemoteBranchSnapshot } from "@varveai/adit-cloud";
import { runGit } from "@varveai/adit-engine";
import { sendLocalRuntimeReport } from "./cloud-runtime-report.js";
import { localCommitBranches } from "./commit-branches.js";

vi.mock("@varveai/adit-cloud", async () => ({...(await import("../../../cloud/src/index.js")),loadCredentials:vi.fn(),collectRemoteBranchSnapshot:vi.fn()}));
vi.mock("./cloud-runtime-report.js",()=>({sendLocalRuntimeReport:vi.fn().mockResolvedValue({})}));
let root:string,store:LocalStore,history:StructuredHistory;
const baseline:CloudBaseline={schemaVersion:1,accountId:"user",before:null,repositories:[],sessions:[],nextCursor:null};
const at=(n:number)=>new Date(Date.UTC(2026,9,16,0,0,n)).toISOString();
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"adit-local-cloud-"));mkdirSync(join(root,".git"));store=new LocalStore(join(root,"state"));new LocalHistory(store.db);createCloudSyncSchema(store);history=new StructuredHistory(store.db);
  vi.mocked(loadCredentials).mockReturnValue({clientId:"device",accountId:"user",credentialId:"credential",serverUrl:"http://localhost:3000",accessToken:"test",refreshToken:"",expiresAt:"",authType:"token"});
  vi.mocked(sendLocalRuntimeReport).mockReset().mockResolvedValue({});
  vi.mocked(collectRemoteBranchSnapshot).mockReset().mockRejectedValue(new Error("Remote unavailable"));
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function workspace(){return store.saveWorkspace({path:root,providers:["codex"],repositories:[],cloud:{enabled:true,mode:"manual",interval:5}});}
function write(extra=false){history.write({id:"native",provider:"codex",cwd:root,messages:[
  {key:"p",role:"user",content:"question",timestamp:at(1),raw:{}},
  {key:"progress",role:"assistant",content:"working",timestamp:at(2),raw:{payload:{phase:"commentary"}},usage:{input_tokens:20,cached_input_tokens:5,output_tokens:3,total_tokens:23},model:"zai/glm-5.3"},
  {key:"tool",role:"assistant",content:{type:"function_call",name:"exec_command",call_id:"call-1",arguments:{cmd:"private command"}},timestamp:at(3),raw:{}},
  {key:"result",role:"tool",content:{type:"function_call_output",call_id:"call-1",output:"private tool output"},timestamp:at(4),raw:{}},
  {key:"final",role:"assistant",content:"final answer",timestamp:at(5),raw:{payload:{phase:"final"}},usage:{input_tokens:30,cached_input_tokens:7,output_tokens:4,total_tokens:34},model:"gpt-test"},
  ...(extra?[{key:"p2",role:"user",content:"next question",timestamp:at(6),raw:{}},{key:"f2",role:"assistant",content:"next answer",timestamp:at(7),raw:{payload:{phase:"final"}}}]:[]),
]});}
function project(b=baseline){const w=workspace();return new CloudProjection(store,w,"scope",structuredClone(b));}
it("indexes sources once per provider while preserving identity precedence, ambiguity and baseline order",()=>{
  const paths=[['native','C:/sessions/own.jsonl'],['fork','C:/sessions/shared.jsonl'],['other','C:/sessions/shared.jsonl']];
  for(const [id,path] of paths) {
    history.write({id,provider:'codex',cwd:root,messages:[]});
    store.db.prepare("INSERT INTO adit_history_sources VALUES (?,?,?,?,8)").run('codex',`${path}#${id}`,id,'hash');
  }
  const metadata=[{transcriptPath:'c:\\SESSIONS\\own.jsonl'},{nativeId:'native',platformSessionId:'native'},
    {nativeId:'elsewhere',transcriptPath:'C:/sessions/own.jsonl'},{platformSessionId:'native'},
    {transcriptPath:'C:/sessions/shared.jsonl'},{nativeId:'native',provider:'claude'},{nativeId:'native'}];
  const sessions=metadata.map((meta,ordinal)=>({id:`cloud-${ordinal}`,platform:'codex',metadata:JSON.stringify(meta),startedAt:at(1),deleted:false,sequence:ordinal,lastEventAt:at(5)}));
  const b={...baseline,sessions},prepare=vi.spyOn(store.db,'prepare'),index=new CloudSessionIndex(store,b);
  for(let attempt=0;attempt<100;attempt++) {
    expect(index.matches('codex','native').map(session=>session.id)).toEqual(['cloud-0','cloud-1','cloud-3','cloud-6']);
    expect(index.matches('codex','fork')).toEqual([]);
    expect(index.matches('codex','missing')).toEqual([]);
  }
  expect(prepare.mock.calls.filter(([sql])=>sql==='SELECT path,session_id FROM adit_history_sources WHERE provider=?')).toHaveLength(1);
  prepare.mockRestore();
  history.write({id:'new-owner',provider:'codex',cwd:root,messages:[]});
  store.db.prepare("INSERT INTO adit_history_sources VALUES (?,?,?,?,8)").run('codex','C:/sessions/own.jsonl#new-owner','new-owner','hash');
  expect(new CloudSessionIndex(store,b).matches('codex','native').map(session=>session.id)).toEqual(['cloud-1','cloud-3','cloud-6']);
});
it("reads sources only once per pending summary and upload projection",()=>{
  write(true);
  history.write({id:'second',provider:'codex',cwd:root,messages:[{key:'p',role:'user',content:'another',timestamp:at(8),raw:{}}]});
  const w=workspace(),prepare=vi.spyOn(store.db,'prepare');
  expect(cloudPending(store,w,'scope',baseline).sessions).toBe(2);
  const scans=()=>prepare.mock.calls.filter(([sql])=>sql==='SELECT path,session_id FROM adit_history_sources WHERE provider=?').length;
  expect(scans()).toBe(1);
  const projection=new CloudProjection(store,w,'scope',baseline);
  expect(projection.sessions()).toHaveLength(2);expect(scans()).toBe(2);
  prepare.mockRestore();
});
it("excludes native approval reviews from pending counts and uploads after archive cleanup",async()=>{
 write();
 const path=join(root,"rollout-review.jsonl");
 const text=JSON.stringify({type:"session_meta",payload:{id:"review",cwd:root,source:{subagent:{other:"guardian"}}}})+"\n";
 writeFileSync(path,text);
 history.write({id:"review",provider:"codex",cwd:root,messages:[
  {key:"p",role:"user",content:"internal review",timestamp:at(1),raw:{}},
  {key:"a",role:"assistant",content:"allow",timestamp:at(2),finalReply:true,raw:{},model:"codex-auto-review"},
 ]});
 store.db.prepare("INSERT INTO adit_history_sources VALUES (?,?,?,?,8)").run("codex",`${path}#review`,"review","old");
 const p=project();expect(cloudPending(store,p.workspace,p.scope,baseline).sessions).toBe(2);
 const archive=new LocalHistory(store.db);
 expect(cloudPending(store,p.workspace,p.scope,baseline).sessions).toBe(1);
 const sessions=new CloudProjection(store,p.workspace,p.scope,baseline).sessions();
 expect(sessions.map(s=>s.source.id)).toEqual(["native"]);
 expect(await archive.scan(root,[{id:"codex",paths:[root]}])).toMatchObject({errors:[],updated:0});
 expect(new CloudProjection(store,p.workspace,p.scope,baseline).sessions().map(s=>s.source.id)).toEqual(["native"]);
});
it("uses native completion instead of compaction and never uploads interruption control messages",()=>{
 history.write({id:'native',provider:'codex',cwd:root,messages:[
  {key:'p',role:'user',content:'question',raw:{},timestamp:at(1)},
  {key:'a',role:'assistant',content:'real final reply',finalReply:true,raw:{payload:{phase:'final_answer'}},timestamp:at(2),usage:{input_tokens:20,output_tokens:3,total_tokens:23}},
  {key:'summary',role:'assistant',content:'context summary',raw:{metadata:{compaction_output:true},payload:{phase:'final_answer'}},timestamp:at(3)},
  {key:'abort',role:'user',content:'<turn_aborted>interrupted</turn_aborted>',raw:{payload:{internal_chat_message_metadata_passthrough:{content_item_kinds:['generic.turn_aborted']}}},timestamp:at(4)},
  {key:'summary2',role:'assistant',content:'more context',raw:{metadata:{compaction_output:true},payload:{phase:'final_answer'}},timestamp:at(5)},
 ]});
 const p=project(),s=p.sessions()[0];const events=[];
 for(const batch of p.sessionBatches(s.source,s.session!)){events.push(...batch);p.confirm('event',batch.map(e=>e.id));}
 expect(events.map(e=>e.text)).toEqual(['question','real final reply']);expect(events[1].usage?.[0].totalTokens).toBe(23);
 expect(cloudPending(store,p.workspace,p.scope,baseline).sessions).toBe(0);
});
it("revisits a corrected final reply even when the old wrong selection closed the turn",()=>{
 history.write({id:'native',provider:'codex',cwd:root,messages:[
  {key:'p',role:'user',content:'question',raw:{},timestamp:at(1)},
  {key:'a',role:'assistant',content:'actual answer',finalReply:true,raw:{},timestamp:at(2)},
  {key:'s',role:'assistant',content:'summary',raw:{metadata:{compaction_output:true}},timestamp:at(3)},
 ]});
 const p=project(),s=p.sessions()[0],t=store.db.prepare('SELECT * FROM adit_history_turns').get() as any;
 p.confirm('event',[p.eventId(t.prompt_message_id)]);p.confirm('turn',[t.id]);p.confirm('usage',[syncKey(t.id,cloudTurnUsage(store,t.id))]);
 store.db.prepare('UPDATE adit_local_cloud_sessions SET revision=?').run(s.source.transcript_revision);
 store.set('cloud-native-context-projection-v1',false);createCloudSyncSchema(store);
 expect(cloudPending(store,p.workspace,p.scope,baseline).sessions).toBe(1);
 expect([...p.sessionBatches(s.source,s.session!)].flat().map(e=>e.text)).toEqual(['actual answer']);
});
it.each(['input_image','image','image_url'])("syncs a %s-only prompt, reply and usage once without sending image bytes",kind=>{
 const provider=kind==='image'?'claude':'codex';
 history.write({id:"image-only",provider,cwd:root,messages:[
  {key:"p",role:"user",content:[{type:"text",text:"\n\t"},{type:kind,image_url:"data:image/png;base64,PRIVATE",source:{data:"PRIVATE"}}],timestamp:at(1),raw:{}},
  {key:"a",role:"assistant",content:"answer to the screenshot",timestamp:at(2),raw:{payload:{phase:"final"}},usage:{input_tokens:20,output_tokens:3,total_tokens:23},model:"test"},
 ]});
 const w=workspace();w.providers.push('claude');const p=new CloudProjection(store,w,'scope',baseline),s=p.sessions()[0];
 expect(cloudPending(store,w,'scope',baseline).sessions).toBe(1);
 const events=[];for(const batch of p.sessionBatches(s.source,s.session!)){events.push(...batch);p.confirm('event',batch.map(e=>e.id));}
 expect(events.map(e=>e.text)).toEqual(['[Image]','answer to the screenshot']);expect(events[1].parentEventId).toBe(events[0].id);
 expect(events[1].usage?.[0].totalTokens).toBe(23);expect(JSON.stringify(events)).not.toContain('PRIVATE');
 expect(cloudPending(store,w,'scope',baseline).sessions).toBe(0);
 const again=new CloudProjection(store,w,'scope',baseline),next=again.sessions()[0];expect([...again.sessionBatches(next.source,next.session!)]).toEqual([]);
});
it("sends an image-only prompt before a reply exists and appends the later reply to that prompt",()=>{
 const image={id:'photo',provider:'codex',cwd:root,messages:[{key:'p',role:'user',content:[{type:'input_image',image_url:'private'}],timestamp:at(1),raw:{}}]};
 history.write(image);const p=project(),s=p.sessions()[0];const first=[];
 for(const batch of p.sessionBatches(s.source,s.session!)){first.push(...batch);p.confirm('event',batch.map(e=>e.id));}
 expect(first.map(e=>e.type)).toEqual(['prompt_submit']);
 history.write({...image,messages:[...image.messages,{key:'a',role:'assistant',content:'answer' as any,timestamp:at(2),raw:{payload:{phase:'final'}}}]});
 const again=new CloudProjection(store,p.workspace,p.scope,baseline),next=again.sessions()[0],later=[...again.sessionBatches(next.source,next.session!)].flat();
 expect(later).toHaveLength(1);expect(later[0]).toMatchObject({type:'assistant_response',parentEventId:first[0].id,text:'answer'});
});
it("revisits skipped image prompts after upgrade without clearing receipts or reuploading inherited history",()=>{
 write();history.write({id:'photo',provider:'codex',cwd:root,messages:[
  {key:'old',role:'user',content:[{type:'input_image',image_url:'private'}],timestamp:at(1),raw:{}},
  {key:'new',role:'user',content:[{type:'input_image',image_url:'private'}],timestamp:at(6),raw:{}},
  {key:'reply',role:'assistant',content:'new reply',timestamp:at(7),raw:{payload:{phase:'final'}}},
 ]});
 const p=project(),all=p.sessions();
 for(const s of all)store.db.prepare('UPDATE adit_local_cloud_sessions SET revision=? WHERE native_id=?').run(s.source.transcript_revision,s.source.id);
 p.confirm('event',['keep-receipt']);store.set('cloud-image-prompt-projection-v1',false);createCloudSyncSchema(store);
 expect(store.db.prepare("SELECT native_id,revision FROM adit_local_cloud_sessions ORDER BY native_id").all()).toEqual([{native_id:'native',revision:1},{native_id:'photo',revision:0}]);
 expect(p.receipt('event','keep-receipt')).toBe(true);
 const inherited=new CloudProjection(store,p.workspace,'scope',{...baseline,before:at(5)}),photo=inherited.sessions().find(s=>s.source.id==='photo')!;
 const events=[...inherited.sessionBatches(photo.source,photo.session!)].flat();expect(events.map(e=>e.startedAt)).toEqual([at(6),at(7)]);
 store.db.prepare("INSERT INTO adit_history_deleted_turns VALUES ('codex','photo','new',1)").run();
 expect([...inherited.sessionBatches(photo.source,photo.session!)]).toEqual([]);
});
it("uploads native segments to one Cloud identity without duplicating events or usage on retry",async()=>{
 write();history.write({id:"native_page",provider:"codex",cwd:root,parentId:"native",relationship:"continuation",messages:[
  {key:"p",role:"user",content:"continued question",timestamp:at(10),raw:{}},
  {key:"a",role:"assistant",content:"continued reply",timestamp:at(11),raw:{payload:{phase:"final"}},usage:{input_tokens:10,output_tokens:2,total_tokens:12},model:"other-model"},
 ]});
 const p=project(),sources=p.sessions();expect(sources).toHaveLength(2);expect(new Set(sources.map(s=>s.session!.id)).size).toBe(1);
 expect(sources.map(s=>s.session!.nativeId)).toEqual(["native","native"]);
 expect(cloudPending(store,p.workspace,p.scope,baseline).sessions).toBe(1);
 const events=[];
 for(const s of sources)for(const batch of p.sessionBatches(s.source,s.session!)){events.push(...batch);p.confirm("event",batch.map(e=>e.id));}
 expect(events.map(e=>e.text)).toEqual(["question","final answer","continued question","continued reply"]);
 expect(events[2].sequence).toBeGreaterThan(events[1].sequence);
 expect(events.flatMap(e=>e.usage||[]).reduce((n,u)=>n+u.totalTokens,0)).toBe(69);
 const again=new CloudProjection(store,p.workspace,p.scope,baseline);expect(again.sessions().flatMap(s=>[...again.sessionBatches(s.source,s.session!)].flat())).toEqual([]);
 expect(cloudPending(store,p.workspace,p.scope,baseline).sessions).toBe(0);
 // Existing bad mappings cannot silently attach acknowledged event IDs to another session.
 store.db.prepare("UPDATE adit_local_cloud_sessions SET cloud_id='old-split' WHERE native_id='native_page'").run();
 const conflict=new CloudProjection(store,p.workspace,p.scope,baseline);expect(conflict.sessions()).toHaveLength(1);
 expect([...conflict.warnings].join(" ")).toContain("Reconcile");
});
it("exports only prompts and final replies while retaining all request usage and actual models",()=>{
  write();const p=project(),s=p.sessions()[0];const events=[...p.sessionBatches(s.source,s.session!)].flat();
  expect(events.map(e=>e.type)).toEqual(["prompt_submit","assistant_response"]);
  expect(events.map(e=>e.text)).toEqual(["question","final answer"]);
  expect(events[1].usage?.map(u=>u.model)).toEqual(["zai/glm-5.3","gpt-test"]);
  expect(events[1].usage?.reduce((n,u)=>n+u.totalTokens,0)).toBe(57);
  expect(JSON.stringify(events)).not.toContain("private tool output");
  expect(JSON.stringify(events)).not.toContain("private command");
});
it("does not treat progress text followed by tools as a completed reply",()=>{
  expect(finalReply([{id:"a",role:"assistant",text:"working",ordinal:1,raw_json:JSON.stringify({payload:{phase:"commentary"}})}],false)).toBeUndefined();
  expect(finalReply([{id:"a",role:"assistant",text:"working",ordinal:1},{id:"b",role:"tool",ordinal:2}],true)).toBeUndefined();
});
it("uploads unanswered and interrupted prompts independently, then sends only a later reply",async()=>{
  const prompt={key:"p",role:"user",content:"question without a reply",timestamp:at(1),raw:{}};
  const progress={key:"progress",role:"assistant",content:"still working",timestamp:at(2),raw:{payload:{phase:"commentary"}}};
  const tool={key:"tool",role:"assistant",content:{type:"function_call",name:"exec_command",call_id:"partial-tool",arguments:{cmd:"private"}},timestamp:at(3),raw:{}};
  const result={key:"result",role:"tool",content:{type:"function_call_output",call_id:"partial-tool",output:"private output"},timestamp:at(4),raw:{}};
  const session={id:"interrupted",provider:"codex",cwd:root,messages:[prompt,progress,tool,result]};
  history.write(session);
  history.write({id:"prompt-only",provider:"codex",cwd:root,messages:[{...prompt,key:"p2",timestamp:at(6)}]});
  const w=workspace(),client={get:vi.fn().mockResolvedValue(structuredClone(baseline)),post:vi.fn(async(_url,payload)=>({
    schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[],
  }))};
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  sync.start(w.id);await sync.wait(w.id);
  const initial=client.post.mock.calls.flatMap(([,p])=>p.events);
  expect(initial.map(e=>e.type)).toEqual(["prompt_submit","prompt_submit"]);
  expect(JSON.stringify(initial)).not.toContain("still working");
  expect(JSON.stringify(initial)).not.toContain("private");
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_receipts WHERE kind IN ('turn','usage')").get()).toEqual({n:0});
  sync.start(w.id);await sync.wait(w.id);expect(client.post).toHaveBeenCalledTimes(2);

  // More tools do not turn an already uploaded prompt into another pending event.
  history.write({...session,messages:[...session.messages,{...tool,key:"tool2"}]});
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  history.write({...session,messages:[...session.messages,{key:"answer",role:"assistant",content:"done",timestamp:at(7),raw:{payload:{phase:"final"}},
    usage:{input_tokens:20,output_tokens:2,total_tokens:22},model:"gpt-test"}]});
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:1,commits:0});
  sync.start(w.id);await sync.wait(w.id);
  const appended=client.post.mock.calls.slice(2).flatMap(([,p])=>p.events);
  expect(appended).toHaveLength(1);expect(appended[0]).toMatchObject({type:"assistant_response",text:"done",parentEventId:initial[0].id});
  expect(appended[0].usage[0].totalTokens).toBe(22);
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  await sync.close();
});
it("keeps an unanswered prompt pending until Cloud acknowledges it, then retries the same event identity",async()=>{
  history.write({id:"open",provider:"codex",cwd:root,messages:[{key:"p",role:"user",content:"open",timestamp:at(1),raw:{}}]});
  const w=workspace(),client={get:vi.fn().mockResolvedValue(structuredClone(baseline)),post:vi.fn(async(_url,payload)=>({
    schemaVersion:1,accountId:"user",eventIds:[],commitIds:[],
  }))};
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  sync.start(w.id);await sync.wait(w.id);
  expect(sync.status(w.id).status).toBe("failed");
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:1,commits:0});
  const id=client.post.mock.calls[0][1].events[0].id;
  client.post.mockImplementation(async(_url,payload)=>({schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[]}));
  sync.start(w.id);await sync.wait(w.id);
  expect(client.post.mock.calls[1][1].events[0].id).toBe(id);
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  await sync.close();
});
it.each([
  [{payload:{phase:"commentary"}},false,false],
  [{payload:{phase:"final"}},false,true],
  [{message:{stop_reason:"end_turn"}},false,true],
  [{finish_reason:"stop"},false,true],
  [{payload:{phase:"analysis"},phase:"final"},true,false],
  [{},true,true],
  [{},false,false],
])("uses the same final-reply evidence for pending counts and upload: %j",(raw,hasNext,expected)=>{
  history.write({id:"reply-evidence",provider:"codex",cwd:root,messages:[{key:"p",role:"user",content:"question",timestamp:at(1),raw:{}},
    {key:"a",role:"assistant",content:"answer",timestamp:at(2),raw}]});
  const turn=store.db.prepare("SELECT id FROM adit_history_turns WHERE session_id='reply-evidence'").get() as {id:string};
  const metadata=cloudFinalReply(store,turn.id,hasNext as boolean);
  const inMemory=finalReply([{id:"answer",role:"assistant",text:"answer",ordinal:1,raw_json:JSON.stringify(raw)}],hasNext as boolean);
  expect(!!metadata).toBe(expected);expect(!!metadata).toBe(!!inMemory);
});
it("continues a historical native session without changing its Cloud identity or reuploading the prefix",()=>{
  write(true);const b={...baseline,before:at(5),sessions:[{id:"old-session",platform:"codex",metadata:JSON.stringify({nativeId:"native"}),startedAt:at(1),deleted:false,sequence:90}]};
  const p=project(b),s=p.sessions()[0],events=[...p.sessionBatches(s.source,s.session!)].flat();
  expect(events.map(e=>e.text)).toEqual(["next question","next answer"]);
  expect(events.every(e=>e.sessionId==="old-session"&&e.sequence>90)).toBe(true);
});
it("uses each historical session's boundary instead of another session's latest event",()=>{
  write(true);
  const b:CloudBaseline={...baseline,before:at(10),sessions:[{id:"old-session",platform:"codex",metadata:JSON.stringify({nativeId:"native"}),startedAt:at(1),deleted:false,sequence:90,lastEventAt:at(5)}]};
  const p=project(b);
  expect(cloudPending(store,p.workspace,p.scope,b).sessions).toBe(1);
  const source=p.sessions()[0];
  const events=[];
  for(const batch of p.sessionBatches(source.source,source.session!)) {
    events.push(...batch);
    p.confirm("event",batch.map(event=>event.id));
  }
  expect(events.map(event=>event.text)).toEqual(["next question","next answer"]);
  expect(events.every(event=>event.sessionId==="old-session"&&event.sequence>90)).toBe(true);
  expect([...p.sessionBatches(source.source,source.session!)].flat()).toEqual([]);
  expect(cloudPending(store,p.workspace,p.scope,b).sessions).toBe(0);
});
it("keeps an ambiguous spanning session pending rather than duplicating old history",()=>{
  write(true);const p=project({...baseline,before:at(5)});expect(p.sessions()).toHaveLength(0);expect([...p.warnings].join(" ")).toContain("identity");
});
it("recovers a legacy Windows transcript identity despite casing, extended prefix and the source marker",()=>{
  write(true);
  store.db.prepare("INSERT INTO adit_history_sources VALUES ('codex',?,'native','test',1)")
    .run("c:\\users\\test\\sessions\\rollout-today.jsonl#native");
  const b={...baseline,before:at(5),sessions:[{id:"legacy",platform:"codex",metadata:JSON.stringify({transcriptPath:"\\\\?\\C:\\Users\\Test\\sessions\\rollout-today.jsonl"}),startedAt:at(1),deleted:false,sequence:90}]};
  const p=project(b),s=p.sessions()[0];
  expect(s.session!.id).toBe("legacy");
  expect([...p.sessionBatches(s.source,s.session!)].flat().map(e=>e.text)).toEqual(["next question","next answer"]);
  expect([...p.warnings]).toEqual([]);
});
it("does not conflate forks or sessions sharing one archive when matching legacy paths",()=>{
  write(true);
  history.write({id:"native_fork",provider:"codex",cwd:root,messages:[{key:"p",role:"user",content:"fork",timestamp:at(1),raw:{}}]});
  const add=store.db.prepare("INSERT INTO adit_history_sources VALUES ('codex',?,?,'test',1)");
  add.run("C:/sessions/archive.jsonl#native","native");add.run("c:/sessions/archive.jsonl#native_fork","native_fork");
  const old={id:"legacy",platform:"codex",metadata:JSON.stringify({transcriptPath:"C:/sessions/archive.jsonl"}),startedAt:at(1),deleted:false,sequence:90};
  const p=project({...baseline,before:at(5),sessions:[old]});
  expect(p.sessions()).toEqual([]);
  old.metadata=JSON.stringify({nativeId:"native",transcriptPath:"C:/sessions/archive.jsonl"});
  const sessions=new CloudProjection(store,p.workspace,"scope",{...baseline,before:at(5),sessions:[old]}).sessions();
  expect(sessions).toHaveLength(1);expect(sessions[0].session).toMatchObject({id:"legacy",nativeId:"native"});
});
it("uses edited text and omits a deleted turn before first upload",()=>{
  write(true);const w=workspace();
  store.db.prepare("INSERT INTO adit_history_text_edits VALUES ('codex','native','p2',0,'edited question',1)").run();
  store.db.prepare("INSERT INTO adit_history_deleted_turns VALUES ('codex','native','p',1)").run();
  const p=new CloudProjection(store,w,"scope",baseline),s=p.sessions()[0],events=[...p.sessionBatches(s.source,s.session!)].flat();
  expect(events.map(e=>e.text)).toEqual(["edited question","next answer"]);
});
it("upgrades cached session boundaries without losing receipts or advancing the original boundary",async()=>{
  write(true);const w=workspace(),scope=syncKey("http://localhost:3000","user",w.id);
  const old={id:"old-session",platform:"codex",metadata:JSON.stringify({nativeId:"native"}),startedAt:at(1),deleted:false,sequence:90};
  const cached={...baseline,before:at(10),sessions:[old,{...old,id:"other-session",metadata:null}]};
  store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES (?,?,?)").run(scope,w.id,JSON.stringify(cached));
  store.db.prepare("INSERT INTO adit_local_cloud_sessions VALUES (?,?,?,?,?,?)").run(scope,"codex","native","old-session",999,90);
  const projection=new CloudProjection(store,w,scope,cached);
  projection.confirm("event",["already-confirmed"]);
  const fresh={...baseline,before:at(30),sessions:[{...old,lastEventAt:at(5)},{...old,id:"other-session",metadata:null,lastEventAt:at(20)}]};
  const client={get:vi.fn().mockResolvedValue(fresh),post:vi.fn(async(_url,payload)=>({schemaVersion:1,accountId:"user",eventIds:payload.events.map((event:any)=>event.id),commitIds:[]}))};
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  sync.start(w.id);await sync.wait(w.id);
  expect(sync.status(w.id).status).toBe("done");
  expect(client.post.mock.calls.flatMap(([,payload])=>payload.events.map((event:any)=>event.text))).toEqual(["next question","next answer"]);
  const saved=JSON.parse((store.db.prepare("SELECT baseline FROM adit_local_cloud_scopes WHERE id=?").get(scope) as any).baseline);
  expect(saved.before).toBe(at(10));expect(saved.sessions.map((session:any)=>session.lastEventAt)).toEqual([at(5),at(10)]);
  expect(projection.receipt("event","already-confirmed")).toBe(true);
  sync.start(w.id);await sync.wait(w.id);expect(client.post).toHaveBeenCalledTimes(1);
  await sync.close();
});
it("rejects legacy Cloud boundaries before uploading or changing cached checkpoints",async()=>{
  write(true);const w=workspace(),scope=syncKey("http://localhost:3000","user",w.id);
  const cached={...baseline,before:at(10),sessions:[{id:"old-session",platform:"codex",metadata:JSON.stringify({nativeId:"native"}),startedAt:at(1),deleted:false,sequence:90}]};
  store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES (?,?,?)").run(scope,w.id,JSON.stringify(cached));
  store.db.prepare("INSERT INTO adit_local_cloud_sessions VALUES (?,?,?,?,?,?)").run(scope,"codex","native","old-session",999,90);
  const client={get:vi.fn().mockResolvedValue(structuredClone(cached)),post:vi.fn()};
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  sync.start(w.id);await sync.wait(w.id);
  expect(sync.status(w.id).status).toBe("failed");expect(sync.status(w.id).error).toContain("Update the Cloud server");
  expect(client.post).not.toHaveBeenCalled();
  expect(store.db.prepare("SELECT baseline FROM adit_local_cloud_scopes WHERE id=?").get(scope)).toEqual({baseline:JSON.stringify(cached)});
  expect(store.db.prepare("SELECT revision FROM adit_local_cloud_sessions WHERE scope=?").get(scope)).toEqual({revision:999});
  await sync.close();
});
it("retries stable identities after a missing acknowledgement and skips confirmed history",async()=>{
  write();const w=workspace();let attempts=0;const ids:string[][]=[];
  const client={get:vi.fn().mockResolvedValue(structuredClone(baseline)),post:vi.fn().mockImplementation(async(_url,payload)=>{
    ids.push(payload.events.map((e:any)=>e.id));attempts++;
    if(attempts===1)throw new Error("Connection ended after server save");
    return {schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[]};
  })};
  const collector={collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)};
  const sync=new LocalCloudSync(store,collector,()=>client);
  const first=sync.start(w.id);expect(sync.start(w.id).id).toBe(first.id);await sync.wait(w.id);expect(first.status).toBe("failed");
  sync.start(w.id);await sync.wait(w.id);expect(ids[0]).toEqual(ids[1]);expect(sync.status(w.id).status).toBe("done");
  sync.start(w.id);await sync.wait(w.id);expect(client.post).toHaveBeenCalledTimes(2);
  write(true);sync.start(w.id);await sync.wait(w.id);expect(ids[2]).toHaveLength(2);expect(ids[2].some(id=>ids[0].includes(id))).toBe(false);
  await sync.close();
});
it("first sync waits for unified collection and analysis before reading or uploading cloud history",async()=>{
  const w=workspace();
  expect(w.started).toBe(false);
  let finishCollection!:()=>void;
  const pending=new Promise<void>(resolve=>{finishCollection=resolve;});
  const collector={collect:vi.fn(),waitFor:vi.fn(async()=>{await pending;write();store.markStarted(w.id);})};
  const client={get:vi.fn().mockResolvedValue(structuredClone(baseline)),post:vi.fn(async(_url,payload)=>({schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[]}))};
  const sync=new LocalCloudSync(store,collector,()=>client);
  sync.start(w.id);
  await Promise.resolve();
  expect(collector.collect).toHaveBeenCalledExactlyOnceWith(w.id);
  expect(collector.waitFor).toHaveBeenCalledExactlyOnceWith(w.id);
  expect(client.get).not.toHaveBeenCalled();
  expect(client.post).not.toHaveBeenCalled();
  finishCollection();
  await sync.wait(w.id);
  expect(sync.status(w.id).status).toBe("done");
  expect(store.workspace(w.id).started).toBe(true);
  expect(client.post.mock.calls.flatMap(([,payload])=>payload.events).map((event:any)=>event.text)).toEqual(["question","final answer"]);
  expect(collector.collect).toHaveBeenCalledTimes(1);
  await sync.close();
});
it("does not confirm a partial acknowledgement",async()=>{
  write();const w=workspace();const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>({get:vi.fn().mockResolvedValue(baseline),post:vi.fn().mockResolvedValue({schemaVersion:1,accountId:"user",eventIds:[],commitIds:[]})}));
  sync.start(w.id);await sync.wait(w.id);expect(sync.status(w.id).status).toBe("failed");
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:1,commits:0});
  expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_receipts").get()).toEqual({n:0});await sync.close();
  expect(sendLocalRuntimeReport).not.toHaveBeenCalled();
});
it("reports runtime only after business acknowledgement and keeps diagnostic errors separate from sync status",async()=>{
  write();const w=workspace();
  const client={get:vi.fn().mockResolvedValue(structuredClone(baseline)),post:vi.fn(async(_url,payload)=>({schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[]}))};
  vi.mocked(sendLocalRuntimeReport).mockImplementation(async()=>{
    expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_receipts WHERE kind='event'").get()).toEqual({n:2});
    return {runtimeReportError:"Diagnostic service unavailable"};
  });
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  sync.start(w.id);await sync.wait(w.id);
  expect(sync.status(w.id)).toMatchObject({status:"done",runtimeReportError:"Diagnostic service unavailable",warnings:[]});
  expect(sendLocalRuntimeReport).toHaveBeenCalledTimes(1);
  sync.start(w.id);await sync.wait(w.id);
  expect(client.post).toHaveBeenCalledTimes(1);expect(sendLocalRuntimeReport).toHaveBeenCalledTimes(2);
  await sync.close();
});
it("sends late usage refinements without resending the prompt or changing immutable body identity",()=>{
  write();const p=project(),s=p.sessions()[0];
  for(const events of p.sessionBatches(s.source,s.session!))p.confirm("event",events.map(e=>e.id));
  store.db.prepare("UPDATE adit_history_usage_entries SET input_total_tokens=40,total_tokens=44 WHERE model='gpt-test'").run();
  store.db.prepare("UPDATE adit_history_sessions SET transcript_revision=transcript_revision+1").run();
  const next=p.sessions()[0],events=[...p.sessionBatches(next.source,next.session!)].flat();
  expect(events).toHaveLength(1);expect(events[0].type).toBe("assistant_response");
  expect(events[0].usageRevision).toBe(2);expect(events[0].usage?.find(u=>u.model==="gpt-test")?.totalTokens).toBe(44);
});

function gitWorkspace() {
  const paths=[join(root,"repo-a"),join(root,"repo-b")];paths.forEach(p=>mkdirSync(p));
  const w=store.saveWorkspace({path:root,providers:["codex"],repositories:paths,cloud:{enabled:true,mode:"manual",interval:5}});
  createAttributionSchema(store.db);
  store.db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES ('run',?,1,'test','done',1)").run(w.id);
  return {w,repos:projectRepositories(store.db,w)};
}
it("syncs configured Git author and default branch without new events, and refreshes changed metadata",async()=>{
  const {w,repos}=gitWorkspace(),repo=repos[0];
  for(const args of [["init","-b","feature/test"],["config","user.name","Configured Author"],["symbolic-ref","refs/remotes/origin/HEAD","refs/remotes/origin/main"]]) {
    expect((await runGit(args,{cwd:repo.path})).exitCode).toBe(0);
  }
  const client={get:vi.fn().mockResolvedValue(structuredClone(baseline)),post:vi.fn(async(_url,payload)=>({schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[]}))};
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  sync.start(w.id);await sync.wait(w.id);
  expect(client.post.mock.calls[0][1].repositories[0]).toMatchObject({gitAuthorName:"Configured Author",defaultBranch:"main"});
  expect(client.post.mock.calls[0][1].events).toEqual([]);
  sync.start(w.id);await sync.wait(w.id);expect(client.post).toHaveBeenCalledTimes(1);
  expect((await runGit(["config","user.name","Updated Author"],{cwd:repo.path})).exitCode).toBe(0);
  sync.start(w.id);await sync.wait(w.id);expect(client.post).toHaveBeenCalledTimes(2);
  expect(client.post.mock.calls[1][1].repositories[0].gitAuthorName).toBe("Updated Author");
  await sync.close();
});
it("refreshes remote-only branch changes, empty snapshots and repeated snapshots without new history",async()=>{
  const {w,repos}=gitWorkspace(),repo=repos[0];
  for(const args of [["init"],["remote","add","origin","https://example.invalid/test.git"]])
    expect((await runGit(args,{cwd:repo.path})).exitCode).toBe(0);
  const branch={name:"main",headSha:"a".repeat(40),isDefault:true};
  const remote=vi.mocked(collectRemoteBranchSnapshot);
  remote.mockResolvedValue({branches:[branch],fingerprint:"first"});
  const client={get:vi.fn().mockResolvedValue(structuredClone(baseline)),post:vi.fn(async(_url,payload)=>({schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[]}))};
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  try {
    for(const branches of [[branch],[],[branch],[branch]]) {
      remote.mockResolvedValue({branches,fingerprint:JSON.stringify(branches)});
      sync.start(w.id);expect((await sync.wait(w.id))?.status).toBe("done");
      expect(client.post.mock.calls.at(-1)![1].repositories[0].remoteBranchSnapshot).toEqual({branches:branches.map(({name,headSha})=>({name,headSha}))});
    }
    expect(client.post).toHaveBeenCalledTimes(4);
    remote.mockRejectedValue(new Error("Remote unavailable"));
    sync.start(w.id);const failed=await sync.wait(w.id);
    expect(failed?.status).toBe("partial");expect(failed?.warnings.join(" ")).toContain("previous branch snapshot");
    expect(client.post.mock.calls.at(-1)![1].repositories[0]).not.toHaveProperty("remoteBranchSnapshot");
  } finally {await sync.close();}
});
function commit(repository:string,sha:string,time:number) {
  store.db.prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,'Test','test@example.invalid',?,'Test','test@example.invalid','subject','subject\n\nbody',1)")
    .run(repository,sha,"0".repeat(40),Date.parse(at(time)),Date.parse(at(time)));
  store.db.prepare(`INSERT INTO adit_attribution_commits(run_id,repository,sha,eligible_lines,excluded_lines,certain_lines,likely_lines,possible_lines,moved_lines,unknown_lines)
    VALUES ('run',?,?,0,0,0,0,0,0,0)`).run(repository,sha);
}
it("syncs Git-derived branches without sessions and repairs confirmed commits without reuploading history",async()=>{
  const {w,repos}=gitWorkspace(),repo=repos[0];
  const git=async(args:string[])=>{
    const result=await runGit(args,{cwd:repo.path});expect(result.exitCode,result.stderr).toBe(0);return result.stdout.trim();
  };
  await git(["init","-b","develop"]);await git(["config","user.name","Test"]);await git(["config","user.email","test@example.invalid"]);
  await git(["symbolic-ref","refs/remotes/origin/HEAD","refs/remotes/origin/develop"]);
  await git(["-c","core.hooksPath=NUL","commit","--allow-empty","-m","First"]);
  const old=await git(["rev-parse","HEAD"]);commit(repo.path,old,2);
  await git(["checkout","-b","feature/test"]);
  await git(["-c","core.hooksPath=NUL","commit","--allow-empty","-m","Second"]);
  const fresh=await git(["rev-parse","HEAD"]);commit(repo.path,fresh,5);
  const source={...structuredClone(baseline),knownCommits:[{localRepositoryId:repo.localRepositoryId,sha:old}]};
  const client={get:vi.fn().mockResolvedValue(source),post:vi.fn(async(_url:string,payload:any)=>({
    schemaVersion:1,accountId:"user",eventIds:payload.events.map((event:any)=>event.id),
    commitIds:payload.commits.map((item:any)=>`${item.localRepositoryId}:${item.sha}`),
    commitBranchIds:(payload.commitBranches??[]).map((item:any)=>`${item.localRepositoryId}:${item.sha}`),
  }))};
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>client);
  try {
    sync.start(w.id);await sync.wait(w.id);
    expect(sync.status(w.id).status).toBe("done");
    const payloads=client.post.mock.calls.map(call=>call[1]);
    expect(payloads.flatMap(payload=>payload.commits)).toMatchObject([{sha:fresh,branch:"feature/test",attributions:[]}]);
    expect(payloads.flatMap(payload=>payload.commitBranches??[])).toEqual(expect.arrayContaining([
      {localRepositoryId:repo.localRepositoryId,sha:old,branch:"develop"},
      {localRepositoryId:repo.localRepositoryId,sha:fresh,branch:"feature/test"},
    ]));
    expect(payloads.every(payload=>!payload.sessions.length&&!payload.events.length)).toBe(true);
    const cached=store.get(`commit-branches:${syncKey(repo.path)}`,null);
    expect((await localCommitBranches(store,repo)).find(branch=>branch.sha===old)?.branch).toBe("develop");
    expect(store.get(`commit-branches:${syncKey(repo.path)}`,null)).toEqual(cached);
    const count=client.post.mock.calls.length;sync.start(w.id);await sync.wait(w.id);
    expect(client.post).toHaveBeenCalledTimes(count);
    await git(["branch","feature/tie","develop"]);
    expect((await localCommitBranches(store,repo)).find(branch=>branch.sha===old)?.branch).toBe("feature/tie");
    await git(["branch","-D","feature/tie"]);
    client.post.mockImplementationOnce(async()=>{throw new Error("offline");});
    store.db.prepare("DELETE FROM adit_local_cloud_receipts WHERE kind='commit-branch'").run();
    sync.start(w.id);await sync.wait(w.id);expect(sync.status(w.id).status).toBe("failed");
    expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_receipts WHERE kind='commit-branch'").get()).toEqual({n:0});
    client.post.mockImplementationOnce(async()=>({schemaVersion:1,accountId:"user",eventIds:[],commitIds:[],commitBranchIds:[]}));
    sync.start(w.id);await sync.wait(w.id);expect(sync.status(w.id).status).toBe("failed");
    expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_receipts WHERE kind='commit-branch'").get()).toEqual({n:0});
    sync.start(w.id);await sync.wait(w.id);expect(sync.status(w.id).status).toBe("done");
    expect(client.post.mock.calls.at(-1)![1].commits).toEqual([]);
  } finally {await sync.close();}
});
it("preserves unmatched commits and continues each repository from its own full Cloud coverage",()=>{
  const {w,repos}=gitWorkspace(),[a,b]=repos;
  const old="a".repeat(40),knownOtherBranch="b".repeat(40),freshA="c".repeat(40),freshB="d".repeat(40);
  commit(a.path,old,2);commit(a.path,knownOtherBranch,5);commit(a.path,freshA,7);commit(b.path,freshB,3);
  const p=new CloudProjection(store,w,"scope",{...baseline,repositories:[{localRepositoryId:a.localRepositoryId,relativePath:a.relativePath,before:at(2),sha:old}],
    knownCommits:[{localRepositoryId:a.localRepositoryId,sha:old},{localRepositoryId:a.localRepositoryId,sha:knownOtherBranch}]});
  const batches=[...p.commitBatches()];
  expect(batches.map(b=>b.commit.sha)).toEqual([freshA,freshB]);
  expect(batches.every(b=>b.commit.attributions.length===0&&b.events.length===0)).toBe(true);
  expect(batches[0].commit.message).toBe("subject\n\nbody");
});
it("does not resend history when a legacy Cloud link cannot be identified as a selected repository",()=>{
  const {w,repos}=gitWorkspace();commit(repos[0].path,"f".repeat(40),8);
  const p=new CloudProjection(store,w,"scope",{...baseline,repositories:[{localRepositoryId:w.id,relativePath:".",before:at(5),sha:"a".repeat(40),legacy:true}]});
  expect([...p.commitBatches()]).toHaveLength(0);expect([...p.warnings].join(" ")).toContain("repository identity");
});
it("uploads separate writer/committer roles and recorded branch, but omits a deleted turn's commit event",()=>{
  write();history.write({id:"writer",provider:"codex",cwd:root,messages:[{key:"wp",role:"user",content:"write",timestamp:at(1),raw:{}},
    {key:"wf",role:"assistant",content:"written",timestamp:at(2),raw:{payload:{phase:"final"}}}]});
  const {w,repos}=gitWorkspace(),repo=repos[0],sha="e".repeat(40);commit(repo.path,sha,8);
  const call=store.db.prepare("SELECT id,turn_id FROM adit_history_tool_calls WHERE source_call_id='call-1'").get() as {id:string;turn_id:string};
  store.db.prepare("UPDATE adit_history_tool_results SET content_text=?,exit_code=0 WHERE tool_call_id=?").run(`[feature/work ${sha.slice(0,7)}] subject`,call.id);
  store.db.prepare(`UPDATE adit_attribution_commits SET submit_provider='codex',submit_session_id='native',submit_turn_id=?,submit_tool_call_id=?,
    match_method='hash',matched_sha=?,eligible_lines=1,certain_lines=1 WHERE sha=?`).run(call.turn_id,call.id,sha,sha);
  store.db.prepare(`INSERT INTO adit_attribution_writers VALUES ('run',?,?,'codex','writer','a.ts',1,0,0)`).run(repo.path,sha);
  const p=new CloudProjection(store,w,"scope",baseline);
  for(const s of p.sessions())for(const events of p.sessionBatches(s.source,s.session!))p.confirm("event",events.map(e=>e.id));
  const item=[...p.commitBatches()][0];
  expect(item.commit.branch).toBe("feature/work");expect(item.events[0].commit?.branch).toBe("feature/work");
  expect(item.commit.attributions.map((a:any)=>[a.committed,a.certain])).toEqual([[false,1],[true,0]]);
  expect(item.events[0].parentEventId).not.toBeNull();
  store.db.prepare("UPDATE adit_attribution_writers SET session_id='native'").run();
  const same=[...p.commitBatches()][0];
  expect(same.commit.attributions).toHaveLength(1);
  expect(same.commit.attributions[0]).toMatchObject({committed:true,certain:1,promptEventId:item.events[0].parentEventId});
  store.db.prepare("UPDATE adit_attribution_writers SET session_id='writer'").run();
  store.db.prepare("INSERT INTO adit_history_deleted_turns VALUES ('codex','native','p',1)").run();
  const deleted=[...p.commitBatches()][0];
  expect(deleted.commit.sha).toBe(sha);expect(deleted.events).toHaveLength(0);
  expect(deleted.commit.attributions).toHaveLength(1);expect(deleted.commit.attributions[0].committed).toBe(false);
});
it("does not advance turn or revision checkpoints when batches are only enumerated",()=>{
  write();const p=project(),s=p.sessions()[0];
  expect([...p.sessionBatches(s.source,s.session!)]).toHaveLength(1);
  expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_receipts").get()).toEqual({n:0});
  expect([...p.sessionBatches(s.source,s.session!)]).toHaveLength(1);
});
it("adds writer evidence across native segments and sends one session reference per commit",()=>{
 write();history.write({id:"native_page",provider:"codex",cwd:root,parentId:"native",relationship:"continuation",messages:[
  {key:"p",role:"user",content:"continued work",timestamp:at(6),raw:{}},
 ]});
 const {w,repos}=gitWorkspace(),sha="9".repeat(40);commit(repos[0].path,sha,8);
 const add=store.db.prepare(`INSERT INTO adit_attribution_writers VALUES ('run',?,?,'codex',?,'a.ts',?,0,?)`);
 add.run(repos[0].path,sha,"native",1,0);add.run(repos[0].path,sha,"native_page",1,1);
 const p=new CloudProjection(store,w,"scope",baseline);p.sessions();const item=[...p.commitBatches()][0];
 expect(item.sessions).toHaveLength(1);expect(item.commit.attributions).toHaveLength(1);
 expect(item.commit.attributions[0]).toMatchObject({certain:2,possible:1});
});

it("counts pending sessions once, excludes deleted turns and reads status without writing or making Cloud requests",async()=>{
  write(true);const w=workspace(),scope=syncKey("http://localhost:3000","user",w.id);
  store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES (?,?,?)").run(scope,w.id,JSON.stringify(baseline));
  const transport=vi.fn(),sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn()},transport);
  store.db.pragma("query_only=ON");
  try {expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:1,commits:0});}
  finally {store.db.pragma("query_only=OFF");}
  expect(transport).not.toHaveBeenCalled();
  expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_sessions").get()).toEqual({n:0});
  expect(store.db.prepare("SELECT count(*) n FROM adit_local_cloud_receipts").get()).toEqual({n:0});
  store.db.prepare("INSERT INTO adit_history_deleted_turns VALUES ('codex','native','p',1),('codex','native','p2',1)").run();
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  await sync.close();
});

it("does not substitute archive totals or last-upload counts before a verified baseline or after an account switch",async()=>{
  write();const w=workspace(),sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn()});
  expect(sync.status(w.id).pending.state).toBe("uninitialized");
  const credentials=loadCredentials(store.directory)!;
  store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES (?,?,?)").run(syncKey(credentials.serverUrl,"user",w.id),w.id,JSON.stringify(baseline));
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:1,commits:0});
  expect(sync.status(w.id,{...credentials,accountId:"other"}).pending.state).toBe("uninitialized");
  expect(sync.status(w.id,{...credentials,serverUrl:"https://other.example"}).pending.state).toBe("uninitialized");
  expect(sync.status(w.id,null).pending.state).toBe("disconnected");
  store.saveWorkspace({...w,cloud:{...w.cloud,enabled:false}},w.id);
  expect(sync.status(w.id).pending.state).toBe("disabled");
  await sync.close();
});

it("updates pending counts after acknowledgements, new turns and late usage, but ignores body-only edits",async()=>{
  write();const w=workspace(),sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn().mockResolvedValue(undefined)},()=>({
    get:vi.fn().mockResolvedValue(structuredClone(baseline)),
    post:vi.fn(async(_url,payload)=>({schemaVersion:1,accountId:"user",eventIds:payload.events.map((e:any)=>e.id),commitIds:[]})),
  }));
  sync.start(w.id);await sync.wait(w.id);
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  store.db.prepare("INSERT INTO adit_history_text_edits VALUES ('codex','native','p',0,'edited',1)").run();
  store.db.prepare("UPDATE adit_history_sessions SET transcript_revision=transcript_revision+1").run();
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  store.db.prepare("UPDATE adit_history_usage_entries SET total_tokens=50 WHERE model='gpt-test'").run();
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:1,commits:0});
  sync.start(w.id);await sync.wait(w.id);
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  write(true);
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:1,commits:0});
  await sync.close();
});

it("counts new content after the inherited history boundary, including sessions still awaiting a final reply",()=>{
  write();const w=workspace(),b={...baseline,before:at(5)};
  expect(cloudPending(store,w,"scope",b)).toEqual({state:"ready",sessions:0,commits:0});
  write(true);
  expect(cloudPending(store,w,"scope",b)).toEqual({state:"ready",sessions:1,commits:0});
  history.write({id:"unfinished",provider:"codex",cwd:root,messages:[{key:"p",role:"user",content:"pending",timestamp:at(8),raw:{}}]});
  history.write({id:"elsewhere",provider:"codex",cwd:join(root,"..","elsewhere"),messages:[{key:"p",role:"user",content:"outside",timestamp:at(8),raw:{}}]});
  expect(cloudPending(store,w,"scope",b)).toEqual({state:"ready",sessions:2,commits:0});
});

it("invalidates cached counts after a collection worker writes through another database connection",async()=>{
  write();const w=workspace(),scope=syncKey("http://localhost:3000","user",w.id);
  store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES (?,?,?)").run(scope,w.id,JSON.stringify(baseline));
  const sync=new LocalCloudSync(store,{collect:vi.fn(),waitFor:vi.fn()});
  const before=sync.status(w.id).pending;
  expect(before).toEqual({state:"ready",sessions:1,commits:0});
  expect(sync.status(w.id).pending).toBe(before);
  const worker=new LocalStore(store.directory);
  try {worker.db.prepare("INSERT INTO adit_history_deleted_turns VALUES ('codex','native','p',1)").run();}
  finally {worker.close();}
  expect(sync.status(w.id).pending).toEqual({state:"ready",sessions:0,commits:0});
  await sync.close();
});

it("uses the same per-repository boundary as uploads, includes unmatched and unanalyzed commits, and excludes merges",()=>{
  const {w,repos:[a,b]}=gitWorkspace();
  const old="a".repeat(40),known="b".repeat(40),fresh="c".repeat(40),unmatched="d".repeat(40),merge="e".repeat(40);
  commit(a.path,old,2);commit(a.path,known,5);commit(a.path,fresh,7);commit(b.path,unmatched,3);commit(b.path,merge,9);
  store.db.prepare("DELETE FROM adit_attribution_commits WHERE sha=?").run(fresh);
  store.db.prepare("INSERT INTO adit_local_commit_parents VALUES (?,?,0,?),(?,?,1,?)").run(b.path,merge,old,b.path,merge,known);
  const inherited={...baseline,repositories:[{localRepositoryId:a.localRepositoryId,relativePath:a.relativePath,before:at(2),sha:old}],
    knownCommits:[{localRepositoryId:a.localRepositoryId,sha:known}]};
  expect(cloudPending(store,w,"scope",inherited)).toEqual({state:"ready",sessions:0,commits:2});
  new CloudProjection(store,w,"scope",inherited).confirm("commit",[`${b.localRepositoryId}:${unmatched}`]);
  expect(cloudPending(store,w,"scope",inherited)).toEqual({state:"ready",sessions:0,commits:1});
  expect(cloudPending(store,w,"scope",{...baseline,repositories:[{localRepositoryId:"legacy",relativePath:".",before:at(5),sha:old,legacy:true}]}).state).toBe("unverified");
});
