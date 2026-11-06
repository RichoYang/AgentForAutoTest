import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createAgentResources, mysqlParameters } from '../src/runner/requirement-agent-resources.js';
import {validateMutationReadback} from '../src/runner/requirement-mutation-measurement.js';
import {createRequirementAgent} from '../src/runner/requirement-agent.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';

test('SQL parameters preserve exact integer/decimal text and reject already-rounded numbers', () => {
  assert.deepEqual(mysqlParameters([40, '2000000000000000001', '0.1000', 0.1, null, true, false]),
    ['40', '2000000000000000001', '0.1000', '0.1', null, '1', '0']);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.throws(() => mysqlParameters([value]), /original decimal or integer as a string/);
  }
});

// Explicit opt-in to a dedicated loopback database server; never uses project credentials.
test('real MySQL preserves BIGINT targeting, numeric amounts, rollback and restoration',
  { skip: !process.env.AGENTOS_TEST_MYSQL_PORT }, async () => {
    const port = Number(process.env.AGENTOS_TEST_MYSQL_PORT);
    assert.ok(Number.isInteger(port) && port > 1024 && port !== 3306);
    const database = 'aos_test_' + randomUUID().replaceAll('-', '');
    const resource = { resource_type: 'mysql', host: '127.0.0.1', port, username: 'root', password: '' };
    const connection = await mysql.createConnection({ host: resource.host, port, user: 'root', password: '',
      flags: ['-CLIENT_QUERY_ATTRIBUTES'], supportBigNumbers: true, bigNumberStrings: true });
    try {
      await connection.query('CREATE DATABASE `' + database + '`');
      await connection.query('USE `' + database + '`');
      await connection.query('CREATE TABLE budget (id BIGINT PRIMARY KEY, amount DECIMAL(18,4), enabled INT)');
      await connection.query('INSERT INTO budget VALUES (2000000000000000001,100,1),(2000000000000000002,200,1)');
      const scope = { state: { operations: {}, schemas: {} }, saveState: async () => {},
        useRead: (_name, fn) => fn(resource) };
      const runtime = createAgentResources({}, scope);
      await runtime.schema({ resource: 'mysql', database, table: 'budget' });
      const update = { kind: 'database', resource: 'mysql', database, table: 'budget', access: 'update',
        values: { amount: { $input: 'amount' } }, where: { id: { $input: 'id' } }, expectedRows: 1 };
      const query = { kind: 'database', resource: 'mysql', database, access: 'read',
        sql: 'SELECT id,amount FROM budget WHERE id=? AND enabled=?', params: [{ $input: 'id' }, 1] };
      const id = '2000000000000000001';
      const original=await runtime.performSpec(query,{id},resource);
      assert.deepEqual(original.columns.map(column=>column.representation),['string','string']);
      const intent={verifySpec:query,snapshot:original,ownership:{field:['rows',0,'id']},stateFields:[['rows',0,'amount']],before:[{field:['rows',0,'amount'],operator:'equals',expected:'100.0000'}],after:[{field:['rows',0,'amount'],operator:'equals',expected:40}]};
      assert.throws(()=>validateMutationReadback(intent),/after.*amount.*string/);
      assert.equal((await runtime.performSpec(query,{id},resource)).rows[0].amount,'100.0000');
      const empty=await runtime.performSpec(query,{id:'2000000000000000999'},resource);assert.equal(empty.rows.length,0);
      validateMutationReadback({...intent,snapshot:empty,before:[{field:['rows',0],operator:'absent'}],after:[{field:['rows',0,'amount'],operator:'equals',expected:'40.0000'}]});
      assert.throws(()=>validateMutationReadback({...intent,snapshot:empty,after:[{field:['rows',0,'typo'],operator:'equals',expected:'40'}]}),/query columns/);
      assert.equal((await runtime.performSpec(update, { id, amount: 40 }, resource)).affectedRows, 1);
      assert.deepEqual((await runtime.performSpec(query, { id }, resource)).rows, [{ id, amount: '40.0000' }]);
      await assert.rejects(runtime.performSpec({ ...update, expectedRows: 2 }, { id, amount: 60 }, resource), /expected 2, actual 1; rolled back/);
      assert.equal((await runtime.performSpec(query, { id }, resource)).rows[0].amount, '40.0000');
      await assert.rejects(runtime.performSpec(update, { id: Number(id), amount: 70 }, resource), /exact finite number/);
      await runtime.performSpec(update, { id, amount: 100 }, resource);
      const [rows] = await connection.query('SELECT id,amount FROM budget ORDER BY id');
      assert.deepEqual(rows, [{ id, amount: '100.0000' }, { id: '2000000000000000002', amount: '200.0000' }]);
      await runtime.close();
    } finally {
      await connection.query('DROP DATABASE `' + database + '`');
      await connection.end();
    }
  });

test('normal agent rejects a future DECIMAL after-contract from real empty-query metadata with zero writes',
 {skip:!process.env.AGENTOS_TEST_MYSQL_PORT},async t=>{
 const port=Number(process.env.AGENTOS_TEST_MYSQL_PORT);assert.ok(port>1024&&port!==3306);const database='aos_contract_'+randomUUID().replaceAll('-','');
 const root=await mkdtemp(path.join(os.tmpdir(),'aos-mysql-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const resource={resource_type:'mysql',host:'127.0.0.1',port,username:'root',password:''},connection=await mysql.createConnection({host:resource.host,port,user:'root',password:'',flags:['-CLIENT_QUERY_ATTRIBUTES']});let writes=0;
 try{
  await connection.query('CREATE DATABASE `'+database+'`');await connection.query('CREATE TABLE `'+database+'`.items(business_key VARCHAR(120) PRIMARY KEY,amount DECIMAL(20,4) NOT NULL)');
  await writeFile(path.join(root,'schema.sql'),'CREATE TABLE items(business_key VARCHAR(120) PRIMARY KEY,amount DECIMAL(20,4) NOT NULL); Test-owned keys can be inserted and deleted by exact primary key. Readback SELECT business_key,amount FROM items WHERE business_key=?.');
  const agent=createRequirementAgent({}, {workDir:root,review:async()=>({accepted:true,errors:[]}),agentModel:async({call})=>({close:async()=>{},async turn(){
   const invoke=(name,args)=>call('test_'+name,{args}),source=await invoke('source',{action:'read',path:'schema.sql'});await invoke('schema',{resource:'mysql',database,table:'items'});
   const register=(name,spec)=>invoke('register',{name,sourceRefs:[source.sourceRef],reason:'actual isolated schema',spec:{resource:'mysql',kind:'database',database,...spec}});
   await register('create_item',{access:'create',table:'items',values:{business_key:{$input:'key'},amount:{$input:'amount'}},expectedRows:1});
   await register('read_item',{access:'read',sql:'SELECT business_key,amount FROM items WHERE business_key=?',params:[{$input:'key'}]});
   await register('delete_item',{access:'delete',table:'items',where:{business_key:{$input:'key'}},expectedRows:1});
   const key='OWNED_decimal';await assert.rejects(invoke('mutate',{id:'create',purpose:'prepare',operation:'create_item',input:{key,amount:'1.0000'},businessKey:key,ownership:{field:['rows',0,'business_key'],value:key},verify:{operation:'read_item',input:{key},before:[{field:['rows',0],operator:'absent'}],after:[{field:['rows',0,'business_key'],operator:'equals',expected:key},{field:['rows',0,'amount'],operator:'equals',expected:1}]},restore:{operation:'delete_item',input:{key}},cleanupAction:'delete exact owned key'}),/after.*amount.*string/);
   assert.equal(writes,0);const [rows]=await connection.query('SELECT COUNT(*) n FROM `'+database+'`.items');assert.equal(Number(rows[0].n),0);
   await invoke('finish',{actual:'Invalid future contract blocked before write',blocker:{dependency:'module fixture',required_action:'native acceptance separately',attempts:['real empty query metadata and independent zero rows']}});return {text:'done'};
  }})});
  await agent.execute({jobId:'JOB-module-decimal',projectId:'module',item:{caseId:'C'},runPrefix:'OWNED_',reports:root,sourceRoot:root,headers:['预期结果'],row:['1. amount 1.0000'],source:{},resourceNames:['mysql'],mutations:[],useRead:(_name,run)=>run(resource),checkOutput:value=>value,invoke:async()=>{writes++;throw Error('Unexpected business write');}});
 }finally{await connection.query('DROP DATABASE IF EXISTS `'+database+'`');await connection.end();}
});
