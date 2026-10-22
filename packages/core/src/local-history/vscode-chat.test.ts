import {expect,it} from "vitest";
import {replayChatOperations} from "./vscode-chat.js";
it("replays a VS Code snapshot with nested set, indexed push and delete operations",()=>{
 const result=replayChatOperations([{kind:0,v:{sessionId:"s",requests:[{requestId:"r",response:[]}]}},{kind:2,k:["requests",0,"response"],v:[{value:"first"},{value:"last"}]},{kind:2,k:["requests",0,"response"],i:1,v:[{value:"middle"}]},{kind:1,k:["customTitle"],v:"Title"},{kind:3,k:["requests",0,"response",0]}]);
 expect(result).toEqual({sessionId:"s",customTitle:"Title",requests:[{requestId:"r",response:[{value:"middle"},{value:"last"}]}]});
});
it("rejects mutation paths that would modify object prototypes or use invalid indices",()=>{
 expect(()=>replayChatOperations([{kind:0,v:{}},{kind:1,k:["__proto__","injected"],v:true}])).toThrow("Unsafe");
 expect(()=>replayChatOperations([{kind:0,v:{items:[]}},{kind:2,k:["items"],i:-1,v:[1]}])).toThrow("index");
 expect({}).not.toHaveProperty("injected");
});
