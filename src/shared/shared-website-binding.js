import{fingerprint}from './environment-access.js';
import{assertSourceRuntimeTier}from './source-environments.js';
// Explicit deployment operation; this never changes the model's project scope.
export function sharedWebsiteBinding(config,projects,{sourceEnvironmentId,targetEnvironmentId,targetProjectId,targetProfile,targetSourceEnvironment}){
 const source=config.environments?.[sourceEnvironmentId],project=projects.projects?.[targetProjectId];
 if(!source||source.kind!=='website'||!project||!targetEnvironmentId||!targetSourceEnvironment||sourceEnvironmentId===targetEnvironmentId)throw Error('Shared website source/target invalid');
 if(config.environments[targetEnvironmentId])throw Error('Target environment already exists; existing configuration preserved');
 assertSourceRuntimeTier(project,targetSourceEnvironment,source.tier);
 if(!Object.values(projects.chatProfileProjectMap??{}).some(map=>map[targetProfile]===targetProjectId))throw Error('Target profile has no trusted project binding');
 const owners=projects.ownerOpenIdsByProfile?.[targetProfile];
 if(!owners?.length)throw Error('Target project owners unavailable');
 const query=source.queries?.investigate;
 if(!query?.reviewed||query.mode!=='investigate'||query.browser!==true)throw Error('Shared source must have a reviewed website investigation');
 const secretKeys=new Set(['password','passwd','pwd','secret','token','authorization','cookie']);
 const containsInlineSecret=value=>value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>secretKeys.has(k.toLowerCase())&&typeof v==='string'&&v.trim()||containsInlineSecret(v));
 if(containsInlineSecret(source))throw Error('Shared service requires credential references, not inline secrets');
 const environment=structuredClone(source);
 environment.projectId=targetProjectId;environment.ownerOpenIdsByProfile={[targetProfile]:[...owners]};
 environment.sharedReadBinding={sourceEnvironmentId,sourceConfigHash:fingerprint(source)};
 // Do not copy arbitrary fixed templates or the source project's ownership.
 environment.queries={investigate:structuredClone(query)};
 return{environment,audit:{sourceEnvironmentId,targetEnvironmentId,targetProjectId,targetProfile,tier:source.tier,
   origin:new URL(source.baseUrl).origin,credentialReferenceReused:true,credentialsCopied:false,newBusinessWritePermission:false}};
}
