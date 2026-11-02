// Short probes release the browser queue/RPC between waits. No total deadline or retry count.
export async function waitForBrowser(run,tool,args={},emit=async()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms))){
 let result=await run(tool,args),waits=0,lastStage=null,lastEmit=0,unknown=result.actionMayHavePerformed===true,performed=result.actionAlreadyPerformed===true;
 const action=!['connection','browser_open','browser_snapshot'].includes(tool);
 while(result.waitingForPage){
  unknown ||= result.actionMayHavePerformed===true;
  performed ||= result.actionAlreadyPerformed===true;
  if(result.stage!==lastStage||Date.now()-lastEmit>=15000){lastStage=result.stage;lastEmit=Date.now();await emit({type:'progress',phase:'tool_activity',activity:{current:result.stage??'等待业务网页加载或网络恢复',total:0,completed:0,recent:[]}});}
  await wait(Math.min(1000+waits++*250,3000));
  result=await run('browser_snapshot',{});
 }
 if(waits&&action){if(unknown)return {...result,partial:true,actionOutcomeUnknown:true,interactionError:'原操作响应尚未确认，先检查当前页面结果，不要盲目重复操作'};if(performed)return {...result,actionAlreadyPerformed:true,note:[result.note,'原操作已发出，等待后仅刷新页面，未重复执行'].filter(Boolean).join('；')};return {...result,partial:true,recoverable:true,interactionError:'等待期间页面或引用已变化，原操作尚未执行；请依据当前新引用继续',actionDeferred:true};}
 return result;
}
