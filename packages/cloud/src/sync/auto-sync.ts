import type Database from "better-sqlite3";
import type { RuntimeReport } from "./runtime-report.js";
/** Historical hooks cannot upload. The local daemon owns all automatic sync. */
export async function triggerAutoSync(_db:Database.Database,_projectId:string,_options?:{projectRoot?:string;collectRuntimeReport?:()=>Promise<RuntimeReport>}):Promise<void>{}
