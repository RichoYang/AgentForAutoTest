import fs from'node:fs/promises';import path from'node:path';import{loadEnvironments}from'../src/shared/environment-access.js';import{sharedWebsiteBinding}from'../src/shared/shared-website-binding.js';
// Stage a reviewed deployment change; never mutate a running instance config.
const args=process.argv.slice(2),flags={};for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1])throw Error('Expected --name value pairs');flags[args[i].slice(2)]=args[i+1];}
for(const key of ['environments','projects','source','target','project','profile','source-environment','output'])if(!flags[key])throw Error('Missing --'+key);
const file=path.resolve(flags.environments),output=path.resolve(flags.output);if(file===output)throw Error('Output must be a separate staged file');
const cfg=await loadEnvironments(file),projects=JSON.parse(await fs.readFile(flags.projects)),binding=sharedWebsiteBinding(cfg,projects,{sourceEnvironmentId:flags.source,targetEnvironmentId:flags.target,targetProjectId:flags.project,targetProfile:flags.profile,targetSourceEnvironment:flags['source-environment']});
cfg.environments[flags.target]=binding.environment;await fs.writeFile(output,JSON.stringify(cfg,null,2)+'\n',{mode:0o600,flag:'wx'});try{await loadEnvironments(output);}catch(error){await fs.unlink(output);throw error;}console.log(JSON.stringify({staged:true,...binding.audit}));
