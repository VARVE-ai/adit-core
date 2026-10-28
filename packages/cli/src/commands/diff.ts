import { withNativeHistory,nativeItem } from "./native-history.js";
function retired(){console.error("Per-turn snapshots are no longer collected. Use adit history commit <sha> for Git commit evidence, or git show <sha> for the commit diff.");process.exitCode=1;}
export async function diffCommand(_id:string,_opts:{maxLines?:number;offsetLines?:number;file?:string}):Promise<void>{retired();}
export async function envCommand(_id:string):Promise<void>{retired();}
export async function envLatestCommand(_opts?:{json?:boolean}):Promise<void>{retired();}
export async function envDiffCommand(_a:string,_b:string,_opts?:{json?:boolean}):Promise<void>{retired();}
export async function envHistoryCommand(_opts?:{limit?:number;json?:boolean}):Promise<void>{retired();}
export async function promptCommand(id:string,opts?:{maxChars?:number;offset?:number}):Promise<void>{await withNativeHistory((r,w)=>{
 const item=nativeItem(r,w,id);if(!item.turn)throw new Error("Pass a native turn ID from adit history show <session-id>.");
 const turn=r.browser.editTurn(w,item.session.provider,item.session.id,item.turn);const text=turn.blocks.filter(b=>b.kind==="prompt").map(b=>b.text).join("\n\n");
 const offset=opts?.offset??0,limit=opts?.maxChars??16000;return {turnId:item.turn,prompt:text.slice(offset,offset+limit),nextOffset:offset+limit<text.length?offset+limit:null};
});}
