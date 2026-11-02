// Executed as a fixed program in the approved page. No model-provided JavaScript.
export function chromePage(request) {
 const {baseUrl,token,tool,args={}}=request;
 const base=new URL(baseUrl), current=new URL(location.href);
 if(current.protocol==='chrome-error:'||location.href==='about:blank')return {waitingForPage:true,pageStatus:current.protocol==='chrome-error:'?'network_error':'loading',partial:true,stage:'等待网络或页面导航恢复'};
 const prefix=base.pathname.replace(/\/$/,'');
 const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
 const busy=current.origin===base.origin&&(document.readyState==='loading'||[...document.querySelectorAll('[aria-busy="true"],.ant-spin-spinning,.el-loading-mask,.ant-skeleton-active')].some(visible));
 if(busy)return {waitingForPage:true,pageStatus:'loading',partial:true,stage:'页面或业务内容正在加载，尚未开始操作'};
 const credentialFormVisible=current.origin===base.origin&&[...document.querySelectorAll('input[type=password]')].some(visible);
 const authPath=/\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(current.pathname+current.hash);
 if(current.origin===base.origin&&authPath&&!credentialFormVisible&&(!document.body?.innerText.trim()||/^(?:加载中|正在加载|Loading)[.。…\s]*$/i.test(document.body.innerText.trim())))return {waitingForPage:true,pageStatus:'loading',partial:true,stage:'登录页面尚未渲染，正在等待'};
 if(current.origin===base.origin&&authPath)return {loginRequired:true,credentialFormVisible,verificationRequired:!credentialFormVisible,stage:'等待日常Chrome页面登录',message:`需要登录 ${base.href}；可在本机登录，或直接回复原任务卡“账号 / 密码”，登录后自动继续。`};
 if(current.origin!==base.origin || !(current.pathname===prefix||current.pathname.startsWith(prefix+'/')))
  return {error:'浏览器已离开本次批准的应用范围，请重新确认页面'};
 if(/^(?:加载中|正在加载|Loading)[.。…\s]*$/i.test(document.body?.innerText.trim()??''))return {waitingForPage:true,pageStatus:'loading',partial:true,stage:'业务页面仍在加载'};
 const write=/新增|创建|保存|修改|编辑|删除|启动|停止|执行|触发|重跑|终止|发布|启用|禁用|提交|审批|支付|注销|退出|\b(add|create|save|update|edit|delete|remove|start|stop|trigger|execute|run|restart|reset|kill|publish|enable|disable|submit|approve|pay|logout)\b/i;
 const terminalWrite=/保存|删除|启动|停止|触发|重跑|终止|发布|提交|审批通过|支付|注销|退出|\b(save|delete|remove|start|stop|trigger|execute|run|restart|kill|publish|submit|approve|pay|logout)\b/i;
 const read=/查看|详情|日志|查询|搜索|下一页|上一页|刷新|展开|收起|search|query|view|detail|log|next|previous|refresh/i;
 const isRow=el=>el.matches('tr[data-row-key],[role="row"][data-row-key],.ant-table-row[data-row-key]');
 const fieldLabel=el=>{
  const explicit=el.id?[...document.querySelectorAll('label[for]')].find(x=>x.htmlFor===el.id)?.innerText:'';
  const group=el.closest('.ant-form-item,.el-form-item,[role=group],fieldset');
  return explicit||group?.querySelector('label,.ant-form-item-label,.el-form-item__label,legend')?.innerText||'';
 };
 const label=el=>{
  const text=(el.getAttribute('aria-label')||(el.closest('[role=grid],.ant-picker-panel,.ant-calendar,.el-picker-panel')?el.getAttribute('title'):'')||((el.matches('input,select,textarea,[role=combobox]'))?fieldLabel(el):'')||el.innerText||el.getAttribute('placeholder')||el.getAttribute('title')||el.getAttribute('name')||el.id||'').trim().slice(0,100);
  return isRow(el)&&text?`行详情：${text}`:text;
 };
 const disabled=el=>el.disabled===true||el.getAttribute('aria-disabled')==='true'||!!el.closest('[aria-disabled=true],.ant-picker-cell-disabled,.ant-calendar-disabled-cell,.ant-picker-disabled,.el-input.is-disabled,.el-date-table td.disabled');
 const picker=el=>!!el.closest('[role=grid],.ant-picker-panel,.ant-calendar,.el-picker-panel,input[type=date],input[type=datetime-local]');
 function type(el){
  if(!visible(el)||el.closest('[contenteditable="true"]'))return null;
  const text=label(el),tag=el.tagName.toLowerCase();if(!text)return null;
  // A menu or a route link opens a page. Creating a record still requires its submit action.
  const menu=el.closest('[role=menu]')&&(el.matches('[role=menuitem]')||el.classList.contains('ant-menu-submenu-title'));
  if(menu&&!terminalWrite.test(text))return 'read-action';
  if(tag==='a'){
   const raw=el.getAttribute('href');if(!raw||raw.startsWith('javascript:'))return null;
   const u=new URL(raw,location.href);
   if(u.origin!==base.origin||!(u.pathname===prefix||u.pathname.startsWith(prefix+'/'))||terminalWrite.test(text)||terminalWrite.test(decodeURIComponent(u.pathname+u.search+u.hash)))return null;
   return 'read-action';
  }
  if(tag==='input'||tag==='textarea'){
   if(tag==='input'&&!/^(text|search|date|datetime-local|number|email|tel|month|time|week)$/.test(el.type))return null;
   if(/password|passwd|secret|token/i.test(el.name+' '+el.id))return null;
   return /搜索|查询|search|filter/i.test(text)?'search':'form-field';
  }
  if(tag==='select')return 'select';
  if(terminalWrite.test(text))return null;
  if(write.test(text)&&!picker(el))return null;
  if(isRow(el))return 'read-action';
  if(picker(el))return 'form-action';
  if(el.matches('[role=option],[role=tab],[role=combobox]'))return 'form-action';
  return read.test(text)?'read-action':null;
 }
 const key='__agentos_read_'+token;
 const state=window[key];
 if(tool==='browser_navigate'){
  let target;try{target=new URL(args.url,location.href);}catch{return {error:'页面地址无效'};}
  const scoped=target.origin===base.origin&&(target.pathname===prefix||target.pathname.startsWith(prefix+'/'));
  const linked=Object.values(state?.refs??{}).some(r=>r.type==='read-action'&&r.href&&new URL(r.href,location.href).href===target.href&&r.el.isConnected);
  const hashRoute=target.pathname===current.pathname&&target.search===current.search&&target.hash.startsWith('#/');
  if(!scoped||terminalWrite.test(decodeURIComponent(target.pathname+target.search+target.hash))||(!linked&&!hashRoute))return {error:'请使用当前页面链接，或同一应用中已从源码核实的前端 hash 路由；不能把业务接口当页面跳转'};
  if(target.href===current.href)return {acted:false,stage:'已在目标页面',url:target.href};
  location.href=target.href;return {acted:true};
 }
 if(!['connection','browser_open','browser_snapshot'].includes(tool)){
  const ref=state?.refs?.[args.ref];
  if(!ref||state.url!==location.href||!ref.el.isConnected||type(ref.el)!==ref.type||label(ref.el)!==ref.label||ref.el.getAttribute('href')!==ref.href)return {recoverable:true,error:'页面引用已变化，请重新获取页面'};
  const el=ref.el;
  if(disabled(el))return {recoverable:true,error:'控件当前被禁用；请根据快照的 disabled、readOnly 和关联字段状态继续定位，不能强制解锁'};
  if(tool==='browser_click'&&['read-action','form-field','form-action'].includes(ref.type))el.click();
  else if(['browser_search','browser_fill'].includes(tool)&&['search','form-field'].includes(ref.type)&&typeof args.text==='string'){
   if(el.readOnly)return {recoverable:true,error:'字段为只读输入，请点击打开日期/选项面板，不强行修改只读值'};
   const setter=Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(el,args.text);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
  }else if(tool==='browser_select'&&ref.type==='select'&&typeof args.value==='string'&&[...el.options].some(o=>o.value===args.value)){
   el.value=args.value;el.dispatchEvent(new Event('change',{bubbles:true}));
  }else return {recoverable:true,error:'该引用不支持此操作；页面导航和临时表单交互可用，业务提交需单独授权'};
  state.refs={};return {acted:true};
 }
 if(credentialFormVisible)return {loginRequired:true,credentialFormVisible:true,verificationRequired:false,stage:'等待日常Chrome页面登录',message:`需要登录 ${base.href}；可在此Chrome页面完成，或直接回复原任务卡“账号 / 密码”，登录后自动继续。`};
 const refs={},controls=[],generation=(state?.generation??0)+1;let n=0;
 for(const el of [...document.querySelectorAll('a,[role=link],button,select,textarea,[role=button],input,[role=menuitem],[role=option],[role=tab],[role=combobox],[role=gridcell],.ant-picker-cell,.ant-calendar-date,.el-date-table td,.ant-menu-submenu-title,tr[data-row-key],[role="row"][data-row-key],.ant-table-row[data-row-key]')].slice(0,500)){
  const t=type(el);if(!t)continue;const ref=token+'-'+generation+'-'+n++;
  const text=label(el);refs[ref]={el,type:t,label:text,href:el.getAttribute('href')};
  controls.push({ref,type:t,label:text,disabled:disabled(el),readOnly:el.readOnly===true,...(['search','form-field','select'].includes(t)?{value:el.value??'',inputType:el.type??'',ariaInvalid:el.getAttribute('aria-invalid'),ariaExpanded:el.getAttribute('aria-expanded')}:{}),...(t==='select'?{options:[...el.options].slice(0,100).map(o=>({value:o.value,label:o.textContent}))}:{})});
  if(controls.length>=150)break;
 }
 Object.defineProperty(window,key,{value:{url:location.href,refs,generation},configurable:true});
 // Read only rendered text nodes, never input values, hidden templates or noscript fallbacks.
 const walker=document.createTreeWalker(document.body??document.documentElement,NodeFilter.SHOW_TEXT);const lines=[];let node,size=0;
 while((node=walker.nextNode())&&size<16000){const el=node.parentElement;
  if(!el||el.closest('script,style,noscript,input,textarea,[contenteditable], [hidden]')||!visible(el))continue;
  const t=node.textContent.trim();if(t){lines.push(t);size+=t.length;}
 }
 const empty=!lines.length&&!controls.length,frameCount=document.querySelectorAll('iframe,frame').length;
 const failedResources=performance.getEntriesByType('resource').filter(r=>['script','link','css'].includes(r.initiatorType)&&r.responseStatus>=400).map(r=>({status:r.responseStatus,type:r.initiatorType}));
 const pageStatus=empty?(document.readyState!=='complete'?'loading':frameCount?'frames':'empty'):'ready';
 return {stage:empty?'尚未读取到业务内容':'已读取日常Chrome业务页面',partial:empty,pageStatus,readyState:document.readyState,frameCount,...(empty&&failedResources.length?{failedResources}:{}),url:current.origin+current.pathname+current.hash,pageText:lines.join('\n'),controls,blockedRequests:[],rows:[],...(empty?{message:frameCount?'当前只读到页面外壳，存在内嵌页面，尚未取得报表内容；不能认定没有数据或没有权限。':'页面尚无可读正文和菜单；可能尚未加载完成，不能认定没有数据或没有权限。'}:{}),note:'复用日常Chrome登录态；仅当前批准应用的可见内容。浏览器正常加载网络请求，不拦截登录或权限初始化。'};
}
