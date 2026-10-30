export function historyBlockDataSql(block = "b", message = "m"): string {
  if (![block, message].every(alias => /^[a-z][a-z0-9_]*$/i.test(alias))) throw new Error("Invalid block data alias");
  return `coalesce(${block}.data_json,CASE WHEN json_valid(${message}.content_json) THEN
    CASE WHEN json_type(${message}.content_json)='array' THEN ${message}.content_json -> ('$['||${block}.block_index||']')
      WHEN ${block}.block_index=0 THEN ${message}.content_json END END)`;
}
