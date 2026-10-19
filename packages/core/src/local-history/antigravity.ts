import {basename,dirname,join} from "node:path";
import {lstat} from "node:fs/promises";
import {createDecipheriv} from "node:crypto";
import {databaseSnapshot,hasTable,readSource,readSourceJSON} from "./source-io.js";
import {array,first,message,session,sorted,table} from "./provider-common.js";
import {HistoryFormatError,jsonLines,record,string,type HistoryMessage} from "./types.js";

interface WireField {number:number;value:bigint|Buffer}
// Independent wire reader; bounded before allocating or descending into untrusted blobs.
export function wireFields(bytes:Buffer):WireField[]{
 let offset=0;const result:WireField[]=[];
 const variable=()=>{let value=0n;for(let n=0;n<10;n++){if(offset>=bytes.length)throw new HistoryFormatError("Truncated protobuf");const next=bytes[offset++];value|=BigInt(next&127)<<BigInt(n*7);if(!(next&128))return value;}throw new HistoryFormatError("Invalid protobuf varint");};
 while(offset<bytes.length){if(result.length>=100000)throw new HistoryFormatError("Protobuf field limit exceeded");const tag=variable(),number=Number(tag>>3n),kind=Number(tag&7n);if(!number)throw new HistoryFormatError("Invalid protobuf field");let value:bigint|Buffer;
  if(kind===0)value=variable();else {const length=kind===2?Number(variable()):kind===1?8:kind===5?4:-1;if(length<0||!Number.isSafeInteger(length)||length>bytes.length-offset)throw new HistoryFormatError("Invalid protobuf length");value=bytes.subarray(offset,offset+length);offset+=length;}result.push({number,value});
 }return result;
}
function wireText(fields:WireField[],depth=0,budget={remaining:100000}):string[]{
 if(depth>16)return [];const result:string[]=[];
 for(const field of fields){if(--budget.remaining<0)throw new HistoryFormatError("Protobuf nesting budget exceeded");if(!Buffer.isBuffer(field.value))continue;
  const text=field.value.toString("utf8");if(text.length>1&&!text.includes("\uFFFD")&&!/[\x00-\x08\x0b-\x1f]/.test(text))result.push(text);
  else try{result.push(...wireText(wireFields(field.value),depth+1,budget));}catch(error){if(error instanceof HistoryFormatError&&error.message.includes("budget"))throw error;}
 }return result;
}
export function decryptAntigravity(bytes:Buffer,keyBase64:string):Buffer{
 const key=Buffer.from(keyBase64,"base64");if(![16,24,32].includes(key.length))throw new HistoryFormatError("ANTIGRAVITY_KEY must contain a base64 AES key");
 for(const mode of ["ctr","cbc","gcm"])for(const skip of [0,1,2,4,8]){
  try{const data=bytes.subarray(skip),nonceLength=mode==="gcm"?12:16;if(data.length<=nonceLength)continue;
   const decipher=createDecipheriv(`aes-${key.length*8}-${mode}`,key,data.subarray(0,nonceLength));let ciphertext=data.subarray(nonceLength);
   if(mode==="gcm"){if(ciphertext.length<16)continue;(decipher as ReturnType<typeof createDecipheriv>&{setAuthTag(tag:Buffer):void}).setAuthTag(ciphertext.subarray(-16));ciphertext=ciphertext.subarray(0,-16);}
   const plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
   for(const post of [0,1,2,4,8])try{const candidate=plain.subarray(post),fields=wireFields(candidate);if(fields.length&&wireText(fields).length)return candidate;}catch{}
  }catch{}
 }
 throw new HistoryFormatError("Antigravity archive could not be decrypted with the configured key");
}
async function exists(path:string){try{return (await lstat(path)).isFile();}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}
export function antigravitySource(path:string){return (/\.(db|pb|trajectory\.json)$/.test(path)&&["conversations","implicit"].includes(basename(dirname(path)))) || (basename(path)==="transcript.jsonl"&&basename(dirname(path))==="logs"&&basename(dirname(dirname(path)))===".system_generated");}
export async function readAntigravity(path:string,provider:string,signal?:AbortSignal){
 const brain=basename(path)==="transcript.jsonl";const id=brain?basename(dirname(dirname(dirname(path)))):basename(path).replace(/\.(?:trajectory\.json|db|pb)$/,"");
 const root=brain?dirname(dirname(dirname(dirname(dirname(path))))):dirname(dirname(path));
 const dbPath=join(root,"conversations",`${id}.db`),sidePath=join(root,basename(dirname(path))==="implicit"?"implicit":"conversations",`${id}.trajectory.json`),brainPath=join(root,"brain",id,".system_generated","logs","transcript.jsonl");
 // One canonical source per identity; companions are loaded by that source.
 if(brain&&await exists(dbPath))return [];
 if(path.endsWith(".trajectory.json")&&(await exists(path.replace(/\.trajectory\.json$/,".db"))||await exists(path.replace(/\.trajectory\.json$/,".pb"))))return [];
 let messages:HistoryMessage[]=[],rawCount=0,usageEvents:unknown[]=[],fidelity="heuristic",cwd="";
 if(path.endsWith(".db")){
  const snapshot=databaseSnapshot(path,db=>({steps:sorted(table(db,"steps",["idx","step_type","step_payload"],["idx","step_type","step_payload"]),"idx"),usage:hasTable(db,"gen_metadata")?table(db,"gen_metadata",["idx","data"],["data"]):[]}));rawCount=snapshot.steps.length;
  messages=snapshot.steps.map((row,index)=>{const payload=Buffer.from(row.step_payload as Uint8Array),fields=wireFields(payload),kind=fields.find(f=>f.number===1&&typeof f.value==="bigint")?.value;return message(row,index,{role:Number(kind??row.step_type)===14?"user":"assistant",content:wireText(fields).join("\n"),raw:{idx:row.idx,step_type:row.step_type,protobuf:payload.toString("base64")}});});
  usageEvents=snapshot.usage.map(row=>({idx:row.idx,protobuf:Buffer.from(row.data as Uint8Array).toString("base64")}));
 }
 if(await exists(sidePath)){
  const doc=await readSourceJSON(sidePath,signal),steps=array(doc.steps);
  if(!Array.isArray(doc.steps))throw new HistoryFormatError("Antigravity trajectory steps are missing");
  if(steps.length>=rawCount){messages=steps.map((step,index)=>{cwd ||= first(step,"runCommand.cwd");return message(step,index,{role:step.userInput?"user":"assistant",content:step.userInput??step.plannerResponse??step.runCommand??step.viewFile??step.codeAction??step.grepSearch??step.errorMessage??step.systemMessage??step,timestamp:first(step,"metadata.createdAt")||undefined});});fidelity="trajectory";if(!usageEvents.length)usageEvents=array(doc.generatorMetadata);}
 }
 if(await exists(brainPath)){
  const rows=jsonLines((await readSource(brainPath,signal)).toString("utf8"));const transcript=rows.filter(row=>["USER_EXPLICIT","MODEL","SYSTEM"].includes(string(row.source))).map((row,index)=>message(row,index,{key:`brain:${row.step_index??index}`,role:row.source==="USER_EXPLICIT"?"user":row.source==="SYSTEM"?"system":"assistant",content:{text:row.content,thinking:row.thinking,tool_calls:row.tool_calls}}));
  if(!messages.length){messages=transcript;fidelity="brain";}
 }
 const historyPath=join(root,"history.jsonl");
 if(!messages.length&&await exists(historyPath)){
  const rows=jsonLines((await readSource(historyPath,signal)).toString("utf8")).filter(row=>first(row,"conversationId","conversation_id","cascadeId")===id);
  messages=rows.map((row,index)=>message(row,index,{role:"user",content:first(row,"display","text","prompt","query")}));if(messages.length)fidelity="history";
 }
 if(!messages.length&&path.endsWith(".pb")){
  if(!process.env.ANTIGRAVITY_KEY)throw new HistoryFormatError("ANTIGRAVITY_KEY is required for encrypted archives without a readable trajectory or brain transcript");
  const plain=decryptAntigravity(await readSource(path,signal),process.env.ANTIGRAVITY_KEY);
  messages=[message({},0,{role:"assistant",content:wireText(wireFields(plain)).join("\n\n"),raw:{format:"protobuf-string-preview"}})];fidelity="decrypted-preview";
 }
 const cachePath=join(root,"cache","last_conversations.json");
 if(!cwd&&await exists(cachePath)){const cache=await readSourceJSON(cachePath,signal);for(const [workspace,value] of Object.entries(cache))if(value===id||first(record(value),"conversationId","cascadeId")===id){cwd=workspace;break;}}
 const result=session(provider,basename(dirname(path))==="implicit"?`implicit-${id}`:id,cwd,messages,{fidelity,usageEvents});
 if(await exists(sidePath)){const doc=await readSourceJSON(sidePath,signal),parent=first(record(doc.agyReader),"parentCascadeId");if(parent){result.parentId=parent;result.relationship="subagent";}}
 return [result];
}
