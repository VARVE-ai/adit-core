import { withNativeHistory } from "./native-history.js";
export type SortField="ACTOR"|"TIME";
export interface ListCommandOptions{limit?:number;actor?:string;type?:string;query?:string;expand?:boolean;sort?:SortField;json?:boolean;}
export async function listCommand(opts:ListCommandOptions={}):Promise<void>{
  await withNativeHistory((r,w)=>{
    if(opts.actor||opts.type||opts.sort==="ACTOR")throw new Error("Actor/event filters belong to retired event storage. Use adit history search or adit history turn.");
    return r.browser.list(w,{query:opts.query,limit:Math.min(50,Math.max(1,opts.limit??20))});
  });
}
