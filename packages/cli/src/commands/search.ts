import { withNativeHistory } from "./native-history.js";
export async function searchCommand(query:string,opts:{limit?:number;actor?:string;type?:string;from?:string;to?:string;branch?:string;format?:string;json?:boolean}={}):Promise<void>{
  await withNativeHistory((r,w)=>{
    if(opts.actor||opts.type||opts.branch)throw new Error("Use adit history search for native transcript search, or adit history commits for commit evidence.");
    return r.browser.list(w,{query,limit:Math.min(50,Math.max(1,opts.limit??20)),from:opts.from?Date.parse(opts.from):undefined,to:opts.to?Date.parse(opts.to):undefined});
  });
}
