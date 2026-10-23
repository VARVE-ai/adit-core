import { startDaemon } from "../local/daemon.js";

export async function localRequest<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const daemon=await startDaemon();
  const response=await fetch(`${daemon.url}/api/local${path}`,{method,headers:{authorization:`Bearer ${daemon.token}`,"content-type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const value=await response.json() as T & {error?:string};
  if(!response.ok)throw new Error(value.error||`Local service returned ${response.status}`);
  return value;
}
