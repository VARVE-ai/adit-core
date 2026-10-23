import {record,string} from "./types.js";

function attachment(file:Record<string,unknown>):Record<string,unknown>[] {
  const mime=string(file.mime),name=string(file.name)||string(file.filename)||mime||"file";
  let text=`[Attachment: ${name}]`;
  if(mime.startsWith("text/") && typeof file.data==="string")text+=`\n${new TextDecoder("utf-8",{fatal:false}).decode(Buffer.from(file.data,"base64"))}`;
  const uri=string(file.url)||string(file.uri)||(typeof file.data==="string"?`data:${mime};base64,${file.data}`:"");
  return [{type:"text",text},...(mime.startsWith("image/")&&uri?[{type:"input_image",image_url:uri}]:[])];
}
export function openCodeContent(data:Record<string,unknown>,parts:Record<string,unknown>[],kind?:string):unknown {
  if(kind==="user")return [{type:"text",text:string(data.text)},...(Array.isArray(data.files)?data.files.flatMap(f=>attachment(record(f))):[])];
  if(kind==="shell")return [{type:"tool_use",id:data.shellID??data.callID,name:data.shellID?"shell":"bash",input:{command:data.command}},
    {type:"tool_result",tool_use_id:data.shellID??data.callID,content:record(data.output).output??data.output,is_error:typeof data.exit==="number"&&data.exit!==0}];
  if(kind && kind!=="assistant")return data.text??data.summary??"";
  const content=kind?data.content:parts;
  if(!Array.isArray(content))return content??data.text??"";
  return content.flatMap((value):unknown[]=>{
    const item=record(value),state=record(item.state);
    if(item.type==="file")return attachment(item);
    if(item.type!=="tool")return [value];
    const id=item.callID??item.id,name=item.tool??item.name;
    const pending=["pending","streaming"].includes(string(state.status));
    return [{type:"tool_use",id,name,input:pending?undefined:state.input},
      ...(["completed","error"].includes(string(state.status))?[{type:"tool_result",tool_use_id:id,
        content:state.output??state.content??record(state.error).message??state.error,is_error:state.status==="error"}]:[])];
  });
}
