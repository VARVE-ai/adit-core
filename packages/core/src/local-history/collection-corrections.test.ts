import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {LocalStore} from '../local-state.js';
import {parseCodexRows,codexResumeState} from './codex.js';
import {parseHarness} from './deepseek-harness.js';
import {StructuredHistory} from './structured-store.js';
import {LocalHistory} from './archive.js';
import {LocalSessionBrowser} from './session-browser.js';
import {LocalInspection} from './inspection.js';
import {LocalPrices} from './pricing.js';
import type {LocalWorkspace} from '../local-state.js';
const dbs:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{dbs.splice(0).forEach(db=>db.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});
function fixture(provider='codex'){
 const root=mkdtempSync(join(tmpdir(),'adit-corrections-'));roots.push(root);
 const db=new LocalStore(join(root,'state')).db;dbs.push(db);const archive=new LocalHistory(db),store=new StructuredHistory(db);
 const workspace:LocalWorkspace={id:'w',name:'test',path:root,version:1,started:true,providers:[provider],repositories:[],cloud:{enabled:false,mode:'manual',interval:5},updatedAt:new Date().toISOString()};
 return {root,db,archive,store,workspace};
}
const at='2026-10-16T07:29:19.000Z';
const usage={input_tokens:100,cached_input_tokens:80,output_tokens:10,total_tokens:110};
const header={type:'session_meta',payload:{id:'s',cwd:'/work'}};
const message=(id:string,role:string,text='Example')=>({type:'response_item',timestamp:at,payload:{id,type:'message',role,content:[{type:'input_text',text}]}});
const native=(id:string,u=usage,total=u)=>({type:'token_usage_record',timestamp:at,payload:{response_id:id,usage:u,thread_token_usage:total}});
const status=(u=usage,total:typeof usage|undefined=u)=>({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{last_token_usage:u,...(total?{total_token_usage:total}:{})}}});
const totals={input_tokens:200,cached_input_tokens:160,output_tokens:20,total_tokens:220};
it('counts independent requests without visible replies, retains message keys, and ignores mirrored/repeated observations',()=>{
 const {db,store}=fixture();
 const rows=[header,message('u','user'),message('a','assistant'),native('one'),status(),
  {type:'response_item',timestamp:at,payload:{id:'thinking',type:'reasoning',summary:[]}},native('two',usage,totals),status(usage,totals),native('two',usage,totals),status(usage,totals)];
 const parsed=parseCodexRows(rows);store.write(parsed);
 expect(parsed.messages.map(m=>m.key)).toEqual(['u','a','thinking']);
 expect(db.prepare("SELECT count(*) n,sum(input_total_tokens) input FROM adit_history_usage_entries WHERE ledger_role='canonical'").get()).toEqual({n:2,input:200});
 expect(store.read('codex','s')).toEqual(parsed);
 store.write(parsed,{rebuild:true});
 expect(db.prepare('SELECT count(*) n FROM adit_history_usage_entries').get()).toEqual({n:2});
});
it('stores multiple native requests on the same message and round-trips each message only once',()=>{
 const {db,store}=fixture();const parsed=parseCodexRows([header,message('u','user'),native('one'),native('two',usage,totals)]);
 store.write(parsed);expect(store.read('codex','s')).toEqual(parsed);
 expect(db.prepare('SELECT count(*) n FROM adit_history_messages').get()).toEqual({n:1});
 expect(db.prepare('SELECT count(*) n FROM adit_history_usage_entries WHERE turn_id IS NOT NULL').get()).toEqual({n:2});
});
it('uses cumulative counters to distinguish equal-sized legacy requests from duplicate status events',()=>{
 const {db,store}=fixture();store.write(parseCodexRows([header,message('u','user'),message('a','assistant'),status(),status(),status(usage,totals),status(usage,totals)]));
 expect(db.prepare('SELECT count(*) n,sum(input_total_tokens) input FROM adit_history_usage_entries').get()).toEqual({n:2,input:200});
});
it('retains legacy usage without totals and keeps missing cache counts unknown',()=>{
 const {db,store}=fixture();const u={input_tokens:20,output_tokens:5};
 const token={type:'event_msg',payload:{type:'token_count',info:{last_token_usage:u}}};
 store.write(parseCodexRows([header,message('u','user'),message('a','assistant'),token,token,message('b','assistant'),token]));
 expect(db.prepare('SELECT input_total_tokens,uncached_input_tokens FROM adit_history_usage_entries').all()).toEqual([
  {input_total_tokens:20,uncached_input_tokens:null},{input_total_tokens:20,uncached_input_tokens:null}]);
});
it('deduplicates native mirrors after compaction resets only the UI cumulative counter',()=>{
 const {db,store}=fixture();const compact={...usage,input_tokens:1000,total_tokens:1010};
 const nativeTotal={...totals,input_tokens:1200,total_tokens:1220};
 store.write(parseCodexRows([header,message('u','user'),message('a','assistant'),native('one'),status(),
  native('compact',compact),status({...usage,input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:50}),
  message('b','assistant'),native('two',usage,nativeTotal),status(usage,totals),status(usage,totals)]));
 expect(db.prepare('SELECT count(*) n,sum(input_total_tokens) input FROM adit_history_usage_entries').get()).toEqual({n:3,input:1200});
});
it('resumes between native usage and its mirror without changing complete-parse results',()=>{
 const {store}=fixture();const first=[header,message('u','user'),message('a','assistant'),native('one')];
 const initial=parseCodexRows(first);store.write(initial);
 const rest=[status(),{type:'event_msg',payload:{type:'task_started'}},status(),message('u2','user'),native('two',usage,totals),status(usage,totals)];
 const resumed=parseCodexRows(rest,undefined,undefined,'codex',{session:store.read('codex','s')!,state:codexResumeState(initial)!});
 expect(resumed).toEqual(parseCodexRows([...first,...rest]));
});
it('rebuilds usage while preserving locally edited prompts and deleted turns',()=>{
 const {db,store}=fixture();const rows=[header,message('u','user'),message('a','assistant'),native('one'),message('delete','user'),native('two',usage,totals)];
 store.write(parseCodexRows(rows));
 db.prepare('INSERT INTO adit_history_text_edits VALUES (?,?,?,?,?,?)').run('codex','s','u',0,'Edited question',1);
 db.prepare('INSERT INTO adit_history_deleted_turns VALUES (?,?,?,?)').run('codex','s','delete',1);
 store.write(parseCodexRows(rows),{rebuild:true});
 expect(store.read('codex','s')!.messages.map(m=>m.key)).toEqual(['u','a']);
 expect(store.read('codex','s')!.messages[0].content).toEqual([{type:'input_text',text:'Edited question'}]);
 expect(db.prepare('SELECT count(*) n FROM adit_history_usage_entries').get()).toEqual({n:1});
});
it('upgrades identical Codex source copies while still rejecting changed native bodies',async()=>{
 const {db,archive,store,root}=fixture();const path=join(root,'rollout-copy.jsonl');
 const rows=[{...header,payload:{id:'s',cwd:root}},message('u','user'),message('a','assistant'),native('one'),status()];
 writeFileSync(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 expect(await archive.scan(root,[{id:'codex',paths:[root]}])).toMatchObject({errors:[],updated:1});
 const old=store.read('codex','s')!;for(const m of old.messages)delete m.usageRecords;store.write(old,{rebuild:true});
 db.exec('UPDATE adit_history_sources SET parser_version=9; UPDATE adit_history_file_checkpoints SET parser_version=9');
 db.prepare('INSERT INTO adit_history_sources VALUES (?,?,?,?,?)').run('codex',join(root,'missing-copy.jsonl')+'#s','s','old',9);
 expect(await archive.scan(root,[{id:'codex',paths:[root]}])).toMatchObject({errors:[],updated:1});
 expect(db.prepare('SELECT count(*) n FROM adit_history_usage_entries').get()).toEqual({n:1});
 expect(store.read('codex','s')!.messages.some(m=>m.usageRecords?.length)).toBe(true);
 rows[1]=message('u','user','Changed native content');
 writeFileSync(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 expect((await archive.scan(root,[{id:'codex',paths:[root]}])).errors).toHaveLength(1);
 expect(store.read('codex','s')!.messages[0].content).toEqual([{type:'input_text',text:'Example'}]);
});
function harness(root:string){
 const rows:Record<string,unknown>[]=[{type:'session',version:4,id:'h',cwd:root}];
 const event=(type:string,data:unknown,surfaceOp?:string)=>rows.push({type,seq:rows.length-1,time:1800000000000+rows.length,data,...(surfaceOp?{surfaceOp}:{})});
 const secret='sk-ant-'+createHash('sha256').update('synthetic-harness-inspection').digest('hex');
 event('turn/start',{turn:1});event('step/start',{turn:1,step:1});
 event('user/message',{role:'user',content:[{type:'text',text:'Inspect'}]},'append');
 event('request/header',{header:{config:{model:'deepseek-test'}}});
 event('assistant/message',{turn:1,step:1,message:{role:'assistant',source:{model:'deepseek-test'},content:[{type:'tool-call',id:'call',name:'bash',arguments:{command:'echo '+secret}}]},usage:{inputTokens:10,cacheReadTokens:80,cacheWriteTokens:0,outputTokens:2,totalTokens:92}},'append');
 event('tool/call',{turn:1,step:1,callId:'call'});
 event('tool/result',{turn:1,step:1,message:{role:'tool',source:{callId:'call'},toolCallId:'call',isError:true,content:[{type:'text',text:secret}]}},'append');
 event('step/end',{turn:1,step:1});event('turn/end',{turn:1});
 return rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
}
it('normalizes native Harness tools and cache-exclusive usage through collection, pricing and timeline',()=>{
 const {db,store,workspace,root}=fixture('deepseek-harness');const parsed=parseHarness(harness(root));store.write(parsed);
 const prices=new LocalPrices(db);prices.install({'deepseek-test':{mode:'chat',input_cost_per_token:0.000002,output_cost_per_token:0.00001,cache_read_input_token_cost:0.0000002}});
 const browser=new LocalSessionBrowser(db,prices),detail=browser.detail(workspace,'deepseek-harness','h');
 expect(db.prepare('SELECT input_total_tokens,uncached_input_tokens,cache_read_tokens FROM adit_history_usage_entries').get()).toEqual({input_total_tokens:90,uncached_input_tokens:10,cache_read_tokens:80});
 expect(db.prepare('SELECT status,tool_call_id FROM adit_history_tool_results').get()).toEqual({status:'failed',tool_call_id:expect.any(String)});
 expect(detail.cost).toBe(56);expect(detail.turns[0].events.map(e=>e.kind)).toEqual(['tool']);
 const call=detail.turns[0].events[0];expect(call.name).toBe('bash');
 expect(browser.content(workspace,'deepseek-harness','h',call.id,'tool-output').text).toContain('••');
 expect(store.read('deepseek-harness','h')).toEqual(parsed);
});
it('upgrades unchanged Harness sources once and preserves finding dispositions, edits and native block identities',async()=>{
 const {db,store,archive,workspace,root}=fixture('deepseek-harness');const text=harness(root),path=join(root,'session.v4.jsonl');writeFileSync(path,text);
 await archive.scan(root,[{id:'deepseek-harness',paths:[root]}]);
 // Model the old derived rows while retaining its native messages and digests.
 db.exec("DELETE FROM adit_history_tool_calls; UPDATE adit_history_tool_results SET source_call_id=NULL,tool_call_id=NULL; UPDATE adit_history_usage_entries SET input_semantics='unknown',input_total_tokens=NULL,uncached_input_tokens=NULL; UPDATE adit_history_sources SET parser_version=6; UPDATE adit_history_file_checkpoints SET parser_version=6;");
 const inspection=new LocalInspection(db);inspection.scanSession('deepseek-harness','h');
 const findings=db.prepare('SELECT id FROM adit_history_secret_findings WHERE active=1 ORDER BY id').all() as {id:string}[];
 expect(findings).toHaveLength(2);
 inspection.setStatus(workspace,findings[0].id,'handled');inspection.setStatus(workspace,findings[1].id,'ignored');
 const prompt=store.read('deepseek-harness','h')!.messages.find(m=>m.role==='user')!;
 db.prepare('INSERT INTO adit_history_text_edits VALUES (?,?,?,?,?,?)').run('deepseek-harness','h',prompt.key,0,'Edited',1);
 expect((await archive.scan(root,[{id:'deepseek-harness',paths:[root]}])).updated).toBe(1);
 inspection.scanSession('deepseek-harness','h');
 expect(db.prepare('SELECT id FROM adit_history_secret_findings WHERE active=1 ORDER BY id').all()).toEqual(findings);
 expect(db.prepare('SELECT status FROM adit_history_secret_dispositions ORDER BY finding_id').all()).toEqual([{status:'handled'},{status:'ignored'}]);
 expect(db.prepare("SELECT count(*) n FROM adit_history_secret_findings WHERE active=1 AND location_kind='tool_input' AND tool_call_id IS NOT NULL").get()).toEqual({n:1});
 expect(db.prepare('SELECT count(*) n FROM adit_history_tool_results WHERE tool_call_id IS NOT NULL').get()).toEqual({n:1});
 expect(store.read('deepseek-harness','h')!.messages.find(m=>m.role==='user')!.content).toEqual([{type:'text',text:'Edited'}]);
 expect((await archive.scan(root,[{id:'deepseek-harness',paths:[root]}])).updated).toBe(0);
});
