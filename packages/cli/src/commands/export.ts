import { withNativeHistory,nativeItem } from "./native-history.js";
import { completeTurn,completeEvents,writeNativeExport } from "./native-export.js";
export async function exportCommand(id:string,opts:{output?:string}):Promise<void>{await withNativeHistory((r,w)=>{
 const item=nativeItem(r,w,id);if(!item.turn)throw new Error("Use adit export session <session-id> for a session, or pass a native turn ID.");
 writeNativeExport({session:{id:item.session.id,provider:item.session.provider},turns:[completeTurn(r,w,item.session.provider,item.session.id,item.turn)]},opts);
});}
export async function exportSessionCommand(id:string|undefined,opts:{format?:string;output?:string;from?:string;to?:string;includeDiffs?:boolean;includeEnv?:boolean;gzip?:boolean}={}):Promise<void>{await withNativeHistory((r,w)=>{
 if(opts.includeDiffs||opts.includeEnv)throw new Error("Per-turn diffs and environment snapshots are not collected. Export the Git commit diff separately.");
 const selected=id??r.browser.list(w,{limit:1}).items[0]?.id;if(!selected)throw new Error("No collected sessions.");
 const session=r.session(w,selected);let detail=r.browser.detail(w,session.provider,session.id,"normal");const turns=[...detail.turns];
 while(detail.nextOffset!==null){detail=r.browser.detail(w,session.provider,session.id,"normal",detail.nextOffset);turns.push(...detail.turns);}
 const context=[...detail.context];let contextOffset=detail.contextNextOffset;
 while(contextOffset!==null){const page=r.browser.context(w,session.provider,session.id,contextOffset);context.push(...page.events);contextOffset=page.nextOffset;}
 completeEvents(r,w,session.provider,session.id,context);
 const from=opts.from?Date.parse(opts.from):-Infinity,to=opts.to?Date.parse(opts.to):Infinity;
 if(Number.isNaN(from)||Number.isNaN(to)||from>to)throw new Error("Invalid date range.");
 writeNativeExport({session:detail.session,context,turns:turns.filter(t=>(t.at??0)>=from&&(t.at??0)<=to).map(t=>completeTurn(r,w,session.provider,session.id,t.id))},opts);
});}
