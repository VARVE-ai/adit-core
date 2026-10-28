import {lstat} from "node:fs/promises";
import {basename,join} from "node:path";
import {inflateRawSync} from "node:zlib";
import {directoryEntries,readSource} from "./source-io.js";
import {HistoryFormatError} from "./types.js";
const limit=128*1024*1024;
const accepts=(name:string,provider:string)=>provider==="gemini-apps"?/\.html?$/i.test(name):/^conversations(?:[-_]\d+)?\.json$/i.test(basename(name));
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
// Read ZIP members in memory; never extract archive-supplied paths to the filesystem.
export function exportZip(bytes:Buffer,provider:string):Buffer[]{
 let end=-1;for(let pos=bytes.length-22;pos>=Math.max(0,bytes.length-65557);pos--)if(bytes.readUInt32LE(pos)===0x06054b50&&pos+22+bytes.readUInt16LE(pos+20)===bytes.length){end=pos;break;}
 if(end<0)throw new HistoryFormatError("Invalid export ZIP directory");
 const count=bytes.readUInt16LE(end+10),directorySize=bytes.readUInt32LE(end+12),directoryOffset=bytes.readUInt32LE(end+16);
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||count===65535||directoryOffset+directorySize>end)throw new HistoryFormatError("Unsupported split or ZIP64 export");
 let offset=directoryOffset,total=0;const results:Buffer[]=[],names=new Set<string>();
 for(let index=0;index<count;index++){
  if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)throw new HistoryFormatError("Invalid export ZIP member");
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),crc=bytes.readUInt32LE(offset+16),compressed=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24),nameSize=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
  if(offset+46+nameSize+extra+comment>end)throw new HistoryFormatError("Truncated export ZIP member");
  const name=bytes.subarray(offset+46,offset+46+nameSize).toString("utf8");offset+=46+nameSize+extra+comment;
  if(!accepts(name,provider))continue;
  if(names.has(name))throw new HistoryFormatError("Duplicate export ZIP member");names.add(name);
  if(flags&1||![0,8].includes(method)||size>limit-total||local+30>directoryOffset||bytes.readUInt32LE(local)!==0x04034b50)throw new HistoryFormatError("Unsupported or oversized export ZIP member");
  const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);if(start+compressed>directoryOffset)throw new HistoryFormatError("Truncated export ZIP data");
  const data=bytes.subarray(start,start+compressed),output=method===0?Buffer.from(data):inflateRawSync(data,{maxOutputLength:Math.min(limit-total,Math.max(size,1))});
  if(output.length!==size||crc32(output)!==crc)throw new HistoryFormatError("Export ZIP integrity check failed");total+=size;results.push(output);
 }
 if(!results.length)throw new HistoryFormatError("No supported conversation files in export ZIP");return results;
}
export async function exportFiles(path:string,provider:string,signal?:AbortSignal):Promise<Buffer[]>{
 const stat=await lstat(path);if(stat.isSymbolicLink())throw new HistoryFormatError("Symbolic export links are not imported");
 if(stat.isFile()){const bytes=await readSource(path,signal);return path.toLowerCase().endsWith(".zip")?exportZip(bytes,provider):[bytes];}
 if(!stat.isDirectory())throw new HistoryFormatError("Export path must be a file or directory");
 const files:Buffer[]=[];let total=0;
 const visit=async(dir:string,depth:number)=>{if(depth>5)throw new HistoryFormatError("Export directory nesting exceeds limit");for(const entry of await directoryEntries(dir)){signal?.throwIfAborted();if(entry.isSymbolicLink())continue;const child=join(dir,entry.name);if(entry.isDirectory())await visit(child,depth+1);else if(entry.isFile()&&accepts(entry.name,provider)){const bytes=await readSource(child,signal);total+=bytes.length;if(total>limit)throw new HistoryFormatError("Export files exceed combined limit");files.push(bytes);}}};
 await visit(path,0);if(!files.length)throw new HistoryFormatError("No supported conversation files in export directory");return files;
}
