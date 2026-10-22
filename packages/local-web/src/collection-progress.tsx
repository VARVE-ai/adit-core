import React from "react";
import {t} from "./i18n";

export type RowProgress={completed:number;total:number|null;status:string;matched?:number};
export function progressCount(progress:Pick<RowProgress,"completed"|"total">,unit:"sessions"|"commits") {
  return t(unit==="sessions"?"{0} / {1} 个会话":"{0} / {1} 个提交",progress.completed,progress.total??"—");
}
export function progressSum(rows:(RowProgress|undefined)[]) {
  return {completed:rows.reduce((n,row)=>n+(row?.completed||0),0),total:rows.some(row=>!row||row.total===null)?null:rows.reduce((n,row)=>n+row!.total!,0)};
}
export function CollectionRowProgress({progress,unit,active}:{progress?:RowProgress;unit:"sessions"|"commits";active:boolean}) {
  const value=progress??{completed:0,total:null,status:"queued"};
  const state=!active&&["queued","counting","running"].includes(value.status)?"interrupted":value.status;
  const label=state==="done"?t("已完成"):state==="running"?t("进行中"):state==="counting"?t("确认总数"):state==="partial"?t("待重试"):state==="skipped"?t("已跳过"):state==="interrupted"?t("已中断"):t("等待中");
  return <span className="collection-row-progress">
    <span className="collection-count">{progressCount(value,unit)}{unit==="commits"&&state==="done"&&value.matched!==undefined&&<> · {t("{0} 个找到会话",value.matched)}</>}</span>
    <span className={`collection-row-state ${state}`}><i aria-hidden="true"/>{label}</span>
  </span>;
}
