import { withNativeHistory,nativeItem } from "./native-history.js";
export async function showCommand(id:string):Promise<void>{await withNativeHistory((r,w)=>{const item=nativeItem(r,w,id);return item.turn?r.browser.turn(w,item.session.provider,item.session.id,item.turn,"normal"):r.show(w,item.session.id,{provider:item.session.provider,mode:"normal",maxChars:16000});});}
