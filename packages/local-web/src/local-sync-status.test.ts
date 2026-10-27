import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it,vi} from "vitest";
import {LocalSyncStatus} from "./local-sync-status";
import {setLanguage} from "./i18n";

vi.mock("./header-status-popover",()=>({HeaderStatusPopover:({children}:{children:React.ReactNode})=>React.createElement("div",null,children)}));

it("shows deferred collection as usable partial results rather than a failure",()=>{
  setLanguage("zh");
  const markup=renderToStaticMarkup(React.createElement(LocalSyncStatus,{
    workspaceId:"workspace",pending:false,onRefresh:()=>{},jobs:[{workspaceId:"workspace",kind:"collect",status:"partial",warnings:["Source changed while reading; retry on the next collection"]}],
  }));
  expect(markup).toContain("已整理内容可正常使用");expect(markup).not.toContain('class="error"');
});
it("continues to expose real errors even when another source is deferred",()=>{
  setLanguage("zh");
  const markup=renderToStaticMarkup(React.createElement(LocalSyncStatus,{
    workspaceId:"workspace",pending:false,onRefresh:()=>{},jobs:[{workspaceId:"workspace",kind:"collect",status:"partial",error:"Invalid JSON record at line 2",warnings:["Source changed while reading; retry on the next collection"]}],
  }));
  expect(markup).toContain('class="error"');expect(markup).toContain("Invalid JSON record at line 2");
});
