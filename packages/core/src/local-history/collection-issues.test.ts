import {expect,it} from "vitest";
import {isRetryableCollectionIssue} from "./collection-issues.js";

it("defers only known temporary collection problems, retaining real errors",()=>{
  for(const code of ["ENOENT","EBUSY","EAGAIN","SQLITE_BUSY","SQLITE_LOCKED"])
    expect(isRetryableCollectionIssue(Object.assign(new Error("temporary"),{code}))).toBe(true);
  for(const message of ["Source changed while reading; retry on the next collection","Git changed while reading; retry on the next collection","Source settings changed; retry with the saved selection","Qoder desktop session metadata is not available yet; retry on the next collection"])
    expect(isRetryableCollectionIssue(new Error(message))).toBe(true);
  for(const code of ["EACCES","EPERM","ENOSPC","SQLITE_CORRUPT","SQLITE_FULL"])
    expect(isRetryableCollectionIssue(Object.assign(new Error("cannot read or write"),{code}))).toBe(false);
  expect(isRetryableCollectionIssue(new Error("Invalid JSON record at line 2"))).toBe(false);
  expect(isRetryableCollectionIssue(new Error("Unsupported Qoder desktop schema"))).toBe(false);
});
