import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const script=fileURLToPath(new URL('./windows-kernel.ps1',import.meta.url));
export function windowsHelper(operation,payload){
 const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 // -Command invokes the checked-in script without changing machine execution policy.
 const command=`& '${script.replaceAll("'","''")}' '${operation}' '${Buffer.from(JSON.stringify(payload)).toString('base64')}'`;
 const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>{});let stderr='',stdout='';let ready=false;
 const closed=new Promise(resolve=>child.once('close',resolve));
 const first=new Promise((resolve,reject)=>{
  child.once('error',reject);child.stderr.on('data',b=>stderr+=b);
  child.stdout.on('data',b=>{stdout+=b;const end=stdout.indexOf('\n');if(!ready&&end!==-1){try{const data=JSON.parse(stdout.slice(0,end).trim());ready=true;resolve(data);}catch(error){reject(error);}}});
  child.once('close',code=>{if(!ready)reject(new Error(`Windows ${operation} failed (${code}): ${stderr.trim()||stdout.trim()}`));});
 });
 return {child,first,closed,diagnostic:()=>stderr.trim()};
}
export async function windowsQuery(operation,payload){const helper=windowsHelper(operation,payload);helper.child.stdin.end();const result=await helper.first;const code=await helper.closed;if(code!==0)throw new Error(`Windows ${operation} failed (${code})`);return result;}
