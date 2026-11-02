import { spawn } from 'node:child_process';
// JSON is embedded in a JavaScript program sent over stdin, never a shell command.
export function chromeTransport(request){
 if(process.platform!=='darwin')throw new Error('日常Chrome接管目前仅支持macOS');
 const program=`var q=${JSON.stringify(request)};var app=Application('Google Chrome');
function main(){
 if(!app.running())return {error:'请先打开日常Google Chrome'};
 var wins=app.windows();
 if(q.operation==='health')return {ok:true,running:true,windows:wins.length};
 if(q.operation==='find'){
  for(var i=0;i<wins.length;i++){var tabs=wins[i].tabs();for(var j=0;j<tabs.length;j++){
   var u=tabs[j].url();var stem=q.baseUrl.replace(/\\/$/,'');
   if(!q.forceNew&&(u===stem||u.indexOf(stem+'/')===0||u.indexOf(stem+'#')===0||u.indexOf(stem+'?')===0)&&q.exclude.indexOf(String(tabs[j].id()))<0)return {tabId:String(tabs[j].id()),windowId:String(wins[i].id())};
  }}
  if(!wins.length)return {error:'请先打开日常Chrome窗口'};
  var selected=wins[0].activeTabIndex();var tab=app.Tab({url:q.baseUrl});wins[0].tabs.push(tab);wins[0].activeTabIndex=selected;return {tabId:String(tab.id()),windowId:String(wins[0].id()),owned:true};
 }
 for(var i=0;i<wins.length;i++){var tabs=wins[i].tabs();for(var j=0;j<tabs.length;j++)if(String(tabs[j].id())===q.tabId){
  if(q.operation==='inspect')return {url:tabs[j].url(),windowId:String(wins[i].id())};
  if(q.operation==='navigate'){tabs[j].url=q.baseUrl;return {ok:true};}
  if(q.operation==='focus'){wins[i].activeTabIndex=j+1;app.activate();return {ok:true};}
  if(q.operation==='execute'){var value=tabs[j].execute({javascript:q.script});if(!value)return {waitingForPage:true,pageStatus:'loading',partial:true,stage:'等待页面文档就绪'};return JSON.parse(value);}
 }}
 return {error:'原Chrome标签页已关闭，请重新打开对应业务页面'};
}
try{JSON.stringify(main());}catch(e){JSON.stringify({error:String(e)});}`;
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/osascript',['-l','JavaScript'],{stdio:['pipe','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Chrome页面或自动化暂未响应，等待后重试'),{code:'CHROME_WAIT'}));},request.timeoutMs??20000);
  child.stdout.on('data',b=>{out+=b;if(out.length>1000000)child.kill();});child.stderr.on('data',b=>{err=(err+b).slice(-2000);});
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Chrome自动化不可用，请检查macOS自动化权限和Chrome Apple事件JavaScript开关'));
   try{const r=JSON.parse(out);if(r.error)throw new Error(r.error);resolve(r);}catch(e){reject(e);}});
  child.stdin.on('error',()=>{});child.stdin.end(program);
 });
}
