import {createReadStream} from 'node:fs';
import {mkdtemp,open,stat,rm,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {hashFile} from './file-digest.js';
// Feishu IM upload accepts at most 30 MB per file. This is a transport chunk,
// never a maximum report size. Leave room for the multipart envelope.
export const FEISHU_FILE_PART_BYTES=29_000_000;
class WideRecord extends Error {}
async function* records(file,maxBytes){
 let quoted=false,fragments=[],length=0;
 for await(const chunk of createReadStream(file)){
  let start=0;
  for(let i=0;i<chunk.length;i++){
   if(chunk[i]===34)quoted=!quoted; // escaped quotes toggle twice, also across chunks
   if(chunk[i]===10&&!quoted){const piece=chunk.subarray(start,i+1);length+=piece.length;if(length>maxBytes)throw new WideRecord();fragments.push(piece);yield Buffer.concat(fragments,length);fragments=[];length=0;start=i+1;}
  }
  if(start<chunk.length){const piece=chunk.subarray(start);fragments.push(piece);length+=piece.length;if(length>maxBytes)throw new WideRecord();}
 }
 if(quoted)throw new Error('CSV引号不完整，不能分卷');
 if(length)yield Buffer.concat(fragments,length);
}
// Temporary transport copies are derived only from an already verified report.
// No caller-selected destination or global download URL is accepted.
export async function prepareReportParts(file,{maxBytes=FEISHU_FILE_PART_BYTES,binary=false}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<16)throw new Error('文件分卷大小无效');
 const info=await stat(file);
 if(info.size<=maxBytes)return {parts:[{file,name:path.basename(file),bytes:info.size,sha256:await hashFile(file)}],close:async()=>{}};
 const root=await mkdtemp(path.join(path.dirname(file),'.delivery-')),parts=[];let current;
 const close=()=>rm(root,{recursive:true,force:true});
 const finish=async()=>{if(!current)return;await current.handle.close();const {file,name,bytes,rows}=current;parts.push({file,name,bytes,rows,sha256:await hashFile(file)});current=null;};
 const start=async(header,suffix='.csv')=>{const name=path.basename(file,'.csv')+'.part'+String(parts.length+1).padStart(4,'0')+suffix;const target=path.join(root,name);current={file:target,name,handle:await open(target,'wx',0o600),bytes:header.length,rows:0};await current.handle.writeFile(header);};
 try{
  let header,mode='csv';
  try{
   if(binary)throw new WideRecord();
   for await(const record of records(file,maxBytes)){
    if(!header){header=record;if(header.length>=maxBytes)throw new WideRecord();continue;}
    if(header.length+record.length>maxBytes)throw new WideRecord();
    if(!current)await start(header);
    if(current.bytes+record.length>maxBytes){await finish();await start(header);}
    await current.handle.writeFile(record);current.bytes+=record.length;current.rows++;
   }
   await finish();if(!parts.length&&header){await start(header);await finish();}
  }catch(error){
   if(!(error instanceof WideRecord))throw error;
   if(current){await current.handle.close();current=null;}
   // A single record too large for the platform is preserved byte-for-byte.
   // Byte parts can be joined; they must never be advertised as standalone CSVs.
   for(const name of await readdir(root))await rm(path.join(root,name),{force:true});parts.length=0;mode='bytes';
   for await(const chunk of createReadStream(file)){
    let offset=0;while(offset<chunk.length){if(!current)await start(Buffer.alloc(0),'.bin');const n=Math.min(maxBytes-current.bytes,chunk.length-offset);await current.handle.writeFile(chunk.subarray(offset,offset+n));current.bytes+=n;offset+=n;if(current.bytes===maxBytes)await finish();}
   }await finish();
  }
  const originalSha256=await hashFile(file),name=path.basename(file,'.csv')+'.README.txt',instructions=binary
   ? '这些二进制分卷按 part 编号顺序拼接后还原原 XLSX；请核对原文件 SHA-256。'
   : mode==='csv'
   ? '这些CSV分卷均可用Excel独立打开，每卷重复表头。按part编号依次查看；合并时仅保留第一卷表头。单元格内换行保留，未截断或丢弃记录。'
   : '单条CSV记录超过飞书单文件容量，故发送原文件的二进制分卷；.bin不能单独用Excel打开。在同一目录按文件名顺序拼接后恢复CSV。\nmacOS/Linux: cat '+path.basename(file,'.csv')+'.part*.bin > '+path.basename(file)+'\nWindows PowerShell: $o=[IO.File]::Create("'+path.basename(file)+'"); try { Get-ChildItem "'+path.basename(file,'.csv')+'.part*.bin" | Sort-Object Name | ForEach-Object { $s=[IO.File]::OpenRead($_.FullName); try {$s.CopyTo($o)} finally {$s.Dispose()} } } finally {$o.Dispose()}';
  const content='AgentOS完整文件分卷交付\n原文件：'+path.basename(file)+'\n原文件字节数：'+info.size+'\n原文件SHA-256：'+originalSha256+'\n'+instructions+'\n'+parts.map(p=>p.name+' | bytes='+p.bytes+(mode==='csv'?' | 数据行='+p.rows:'')+' | sha256='+p.sha256).join('\n')+'\n';
  // Manifests are also transport files, so even an unusually large manifest is chunked.
  const body=Buffer.from(content);for(let offset=0,index=1;offset<body.length;offset+=maxBytes,index++){const partName=body.length<=maxBytes?name:name+'.part'+String(index).padStart(4,'0')+'.txt',target=path.join(root,partName),chunk=body.subarray(offset,offset+maxBytes);await writeFile(target,chunk,{mode:0o600,flag:'wx'});parts.push({file:target,name:partName,bytes:chunk.length,sha256:await hashFile(target)});}
  return {parts,mode,originalSha256,close};
 }catch(error){if(current)await current.handle.close().catch(()=>{});await close();throw error;}
}
