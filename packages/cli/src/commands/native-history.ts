import { analyticsSessions, type LocalWorkspace } from "@varveai/adit-core";
import { LocalHistoryReader, historyError } from "../local/history-reader.js";

export async function withNativeHistory(action:(reader:LocalHistoryReader,w:LocalWorkspace)=>unknown|Promise<unknown>):Promise<void>{
  let reader:LocalHistoryReader|undefined;
  try{reader=new LocalHistoryReader();const w=reader.workspace();const result=await action(reader,w);if(result!==undefined)console.log(JSON.stringify(result,null,2));}
  catch(error){console.error(JSON.stringify(historyError(error)));process.exitCode=1;}finally{reader?.close();}
}
export function nativeItem(reader:LocalHistoryReader,w:LocalWorkspace,id:string){
  const sessions=analyticsSessions(reader.db,w);
  const found=sessions.filter(s=>s.id===id);
  if(found.length===1)return {session:found[0],turn:undefined};
  const turns=reader.db.prepare("SELECT id,provider,session_id FROM adit_history_turns WHERE id=?").all(id) as {id:string;provider:string;session_id:string}[];
  const matches=turns.flatMap(t=>sessions.filter(s=>s.id===t.session_id&&s.provider===t.provider).map(s=>({session:s,turn:t.id})));
  if(matches.length===1)return matches[0];
  throw new Error("Use an exact collected session or turn ID from adit history. Legacy event IDs are not mapped to native records.");
}
