import {chmod,lstat,mkdir,open,unlink} from 'node:fs/promises';
import {windowsHelper,windowsQuery} from './windows-kernel.js';
// Apply only to an explicitly owned private file/subdirectory, never to a user home or shared data root.
export async function protectPrivatePath(file,directory=false){
 const info=await lstat(file);if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()))throw new Error('Private path must be a regular '+(directory?'directory':'file'));
 if(process.platform==='win32')await windowsQuery('acl',{file});else await chmod(file,directory?0o700:0o600);
}
export async function privateDirectory(directory){
 if(process.platform==='win32')await windowsQuery('privateDirectory',{file:directory});else await mkdir(directory,{recursive:true,mode:0o700});
 await protectPrivatePath(directory,true);
}
export async function writePrivateFile(file,data){
 if(process.platform==='win32'){
  const helper=windowsHelper('privateWrite',{file});let created=false;
  try{const ready=await helper.first;if(!ready.created)throw new Error('Private file creation was not acknowledged');created=true;helper.child.stdin.end(data);const code=await helper.closed;if(code!==0)throw new Error(`Windows private write failed (${code}): ${helper.diagnostic()}`);}
  catch(error){helper.child.stdin.end();await helper.closed;if(created)await unlink(file).catch(()=>{});throw error;}return;
 }
 const handle=await open(file,'wx',0o600);let complete=false;
 try{await protectPrivatePath(file);await handle.writeFile(data);complete=true;}finally{await handle.close();if(!complete)await unlink(file).catch(()=>{});}
}
export async function privatePathProof(file,directory=false){
 const info=await lstat(file);if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()))throw new Error('Invalid private path');
 if(process.platform!=='win32')return {private:(info.mode&0o777)===(directory?0o700:0o600),mode:info.mode&0o777};
 const acl=await windowsQuery('inspectAcl',{file}),allowed=new Set([acl.user,'S-1-5-18']);
 return {...acl,private:acl.owner===acl.user&&acl.rules.some(r=>r.allow&&r.sid===acl.user)&&acl.rules.every(r=>!r.allow||allowed.has(r.sid))};
}
