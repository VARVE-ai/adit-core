import { it, expect, vi } from "vitest";
import { triggerAutoSync } from "./auto-sync.js";
it("retired hook auto-sync never reads old SQL or uploads",async()=>{
 const db=new Proxy({}, {get(){throw new Error("old DB must not be touched");}});const collectRuntimeReport=vi.fn();
 await expect(triggerAutoSync(db as never,"project",{projectRoot:"/missing",collectRuntimeReport})).resolves.toBeUndefined();expect(collectRuntimeReport).not.toHaveBeenCalled();
});
