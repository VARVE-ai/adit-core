import { expect,it } from "vitest";
import { parseGeminiAppsHTML } from "./gemini-apps.js";
const cell=(label:string,content:string)=>`<div class="outer-cell"><div class="header-cell"><h3>Gemini Apps</h3><p>${label}</p><p>Oct 1, 2026, 2:03:04 PM PDT</p></div><div class="content-cell">${content}</div></div>`;
it("imports only Gemini Apps Prompted cells, converts explicit timezone, and excludes executable/hidden content",()=>{
  const html=`<html lang="en"><head><title>My Activity History</title></head><body>${cell("Canvas","ignored")}${cell("Prompted","<p>prompt &amp; detail</p><p>answer</p><script>secret</script><template>hidden</template>")}</body></html>`;
  const result=parseGeminiAppsHTML(html,"D:/work");
  expect(result).toHaveLength(1);
  expect(result[0].messages[0]).toMatchObject({role:"user",content:"prompt & detail\n\nanswer",timestamp:"2026-10-01T21:03:04.000Z"});
  expect(parseGeminiAppsHTML(html,"D:/work")[0].id).toBe(result[0].id);
});
it("rejects unsupported Takeout locale and unknown timezone instead of silently interpreting local time",()=>{
  expect(()=>parseGeminiAppsHTML('<html lang="zh"><title>My Activity</title></html>',"work")).toThrow("locale");
  expect(()=>parseGeminiAppsHTML(`<title>My Activity</title>${cell("Prompted","prompt").replace("PDT","XYZ")}`,"work")).toThrow("zone");
});
