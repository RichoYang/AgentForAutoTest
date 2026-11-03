import {websiteApplication} from './website-application.js';
import {websiteUrl} from './website-policy.js';
const normalize=url=>websiteUrl(url).replace(/\/$/,'');
export function validateWebsiteAliases(config){
 const list=config.websiteAliases??[];
 if(!Array.isArray(list)||list.length>100)throw new Error('网站入口更正配置无效');
 const keys=new Set();
 for(const a of list){
  if(!a||typeof a.projectId!=='string'||!['uat','prd'].includes(a.tier)||typeof a.from!=='string'||typeof a.to!=='string')throw new Error('网站入口更正字段无效');
  const key=JSON.stringify([a.projectId,a.tier,normalize(a.from)]);
  if(keys.has(key)||normalize(a.from)===normalize(a.to))throw new Error('网站入口更正重复');
  keys.add(key);websiteUrl(a.to);
 }
 for(const a of list)if(keys.has(JSON.stringify([a.projectId,a.tier,normalize(a.to)])))throw new Error('网站入口更正不允许链式或循环映射');
}
export function canonicalWebsite(config,projectId,tier,url,{applicationRoot=true}={}){
 validateWebsiteAliases(config);
 const found=(config.websiteAliases??[]).find(a=>a.projectId===projectId&&a.tier===tier&&normalize(a.from)===normalize(url));
 const corrected=found?websiteUrl(found.to):websiteUrl(url);
 return websiteUrl((applicationRoot?websiteApplication(config,projectId,tier,corrected)?.entry.baseUrl:null)??corrected);
}
