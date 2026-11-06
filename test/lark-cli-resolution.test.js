import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLarkCliEntry } from '../src/control-plane/lark-cli.js';

test('POSIX Node prefix layout resolves global lark-cli independently of host platform',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-lark-prefix-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=path.join(root,'bin','node'),entry=path.join(root,'lib','node_modules','@larksuite','cli','scripts','run.js');
 await mkdir(path.dirname(entry),{recursive:true});await writeFile(entry,'');
 assert.equal(resolveLarkCliEntry('',executable,'linux'),entry);
});

test('explicit lark-cli entry remains authoritative',()=>{
 assert.equal(resolveLarkCliEntry('./custom-cli.cjs','/unused/bin/node'),path.resolve('./custom-cli.cjs'));
});
