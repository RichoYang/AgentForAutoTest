import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { reportFile } from '../../../src/shared/report-files.js';
import { enqueueRequirementBundle, deliverRequirementBundle } from '../../../src/control-plane/requirement-delivery.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>JSON.parse(await readFile(file,'utf8'));

export function checkedReceipt(receipt,{rootId,threadId,appId,text,attachments,messageIds}) {
  assert.equal(receipt.verified,true);
  assert.equal(receipt.messages.length,3);
  assert.equal(new Set(receipt.messages.map(message=>message.messageId)).size,3);
  for(const [index,message] of receipt.messages.entries()){
    const {messageId,readback}=message;
    assert.equal(messageId,messageIds[index]);
    assert.equal(message.link,'https://applink.feishu.cn/client/message/open?message_id='+encodeURIComponent(messageId));
    assert.equal(readback.messageId,messageId);
    assert.equal(readback.rootId,rootId);
    assert.equal(readback.threadId,threadId);
    assert.deepEqual(readback.sender,{sender_type:'app',id:appId});
    if(index===0){
      assert.equal(message.sha256,undefined);
      assert.equal(readback.bodyHash,sha(text));
    }else{
      assert.match(attachments[index-1],/^[a-f0-9]{64}$/);
      assert.equal(message.sha256,attachments[index-1]);
      assert.equal(readback.sha256,message.sha256);
      assert.equal(readback.fileKey,messageId);
    }
  }
  // Normalize the JSON representation only after checking the kind-specific fields.
  return JSON.parse(JSON.stringify(receipt));
}

export async function readBundle({dataDir,jobId,journal,bundle}) {
  const envelope=await reportFile(dataDir,jobId,bundle);
  const bytes=await readFile(envelope.file);
  assert.equal(sha(bytes),bundle.sha256);
  const document=JSON.parse(gunzipSync(bytes));
  assert.equal(document.manifest.jobId,jobId);
  const files=[];
  for (const {name,bytes:size,sha256,contentBase64} of document.files) {
    const content=Buffer.from(contentBase64,'base64');
    assert.equal(content.length,size);assert.equal(sha(content),sha256);
    const owners=[path.join(journal.reportDirectory,name),path.join(dataDir,'requirement-tests',jobId,'diagnostics',name)];
    const hashes=await Promise.all(owners.map(file=>readFile(file).then(sha,error=>{if(error.code==='ENOENT')return null;throw error;})));
    assert.deepEqual([...new Set(hashes.filter(Boolean))],[sha256],name);
    files.push({name,bytes:size,sha256});
  }
  assert.ok(files.length>0);
  const verification=path.join(path.dirname(envelope.file),bundle.id+'.verification.json');
  assert.equal(sha(await readFile(verification)),bundle.verificationHash);
  assert.deepEqual((await read(verification)).files,{count:files.length,sha256:sha(JSON.stringify(files))});
  return {sha256:bundle.sha256,count:files.length,verificationHash:bundle.verificationHash,files};
}

export async function checkDelivery({root,dataDir,jobId,journal,store,projects}) {
  const job=await store.getJob(jobId);
  assert.equal(job.status,'completed');
  const [workbook,bundle]=job.result.requirementDelivery.artifacts;
  assert.equal(workbook.kind,'requirement-xlsx');
  assert.equal(bundle.kind,'requirement-evidence');
  const archive=await readBundle({dataDir,jobId,journal,bundle});
  const transport=path.join(root,'mock-transport');await mkdir(transport);
  const uploaded=new Map(), sent=new Map();
  let sendAttempts=0;
  const settings=projects.projects[job.projectId].requirementTest;
  const context={config:{dataDir,projects:projects.projects},projects,store};
  assert.equal(await enqueueRequirementBundle(context,job),true);
  const [{key,entry}]=Object.entries((await store.read()).requirementDeliveries).map(([key,entry])=>({key,entry}));
  const {rootId,chatId,appId,profile}=entry.destination;
  assert.equal(chatId,job.chatId);assert.equal(profile,settings.bot.profile);assert.equal(appId,settings.bot.appId);
  const assertOptions=options=>{assert.equal(options.profile,profile);assert.equal(options.replyInThread,true);};
  const send=async(id,value,options,attachment)=>{
    sendAttempts++;
    assert.equal(id,rootId);assertOptions(options);
    if (sent.has(options.idempotencyKey)) return {message_id:sent.get(options.idempotencyKey)};
    const messageId='mock-message-'+(sent.size+1);
    sent.set(options.idempotencyKey,messageId);
    const body=attachment?{file_name:path.basename(value),file_key:messageId}:{text:value};
    if(attachment)await copyFile(value,path.join(transport,messageId));
    uploaded.set(messageId,body);
    return {message_id:messageId};
  };
  context.feishu={
    reply:(id,value,options)=>send(id,value,options,false),
    replyFile:(id,value,options)=>send(id,value,options,true),
    readMessage:async(id,options)=>{
      assertOptions(options);
      return id===rootId?{chat_id:chatId,message_id:rootId,thread_id:'mock-thread'}
        :{chat_id:chatId,message_id:id,root_id:rootId,thread_id:'mock-thread',sender:{sender_type:'app',id:appId},
          body:{content:JSON.stringify(uploaded.get(id))}};
    },
    downloadMessageResource:async(id,messageId,fileKey,kind,options)=>{
      assertOptions(options);
      assert.equal(id,jobId);assert.equal(fileKey,messageId);assert.equal(kind,'file');
      return {path:path.join(transport,fileKey)};
    },
  };
  const receipt=await deliverRequirementBundle(context,key);
  assert.equal(sendAttempts,3);
  const expected={rootId,threadId:'mock-thread',appId,text:entry.parts[0].text,
    attachments:[workbook.sha256,bundle.sha256],messageIds:[...sent.values()]};
  const persisted=checkedReceipt(receipt,expected);
  assert.deepEqual(checkedReceipt((await store.getJob(jobId)).requirementDeliveryReceipt,expected),persisted);
  assert.deepEqual(checkedReceipt(await deliverRequirementBundle(context,key),expected),persisted);
  assert.equal(sendAttempts,3);
  return {verified:true,simulatedTransport:true,parts:receipt.messages.length,attachments:receipt.messages.slice(1).map(row=>row.sha256),
    bundle:archive,mutations:journal.mutations?.length??0};
}
