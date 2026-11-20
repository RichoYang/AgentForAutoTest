import assert from 'node:assert/strict';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import mysql from 'mysql2/promise';

const cases={
  wide6:{module:'角色目录与客户库存结构验收',tables:[['convergence_role_sit','role_info','ID'],['convergence_inventory_sit','ltx_customer_inventory','ID']]},
  holdout6:{module:'档期场次与电子票重新签发验收',tables:[['theater_schedule_sit','screening_slot',['THEATER_ID','SHOW_DAY','SLOT_ID']],['theater_ticket_sit','ticket_reissue',['TICKET_NO','ISSUE_NO']]]},
  negative6:{module:'档案编号与检索结构验收',tables:[['convergence_archive_sit','archive_record','RECORD_ID'],['convergence_search_sit','archive_index','INDEX_ID']]},
};
export const fixtureModule=mode=>cases[mode].module;
export function fixtureSource(mode) {
  const c=cases[mode];
  return c.tables.map(([database,table,key])=>[
    '// This fixture repository defines static entity mapping and the SIT configuration.',
    '// The lab connector is external to the service. There are no business rows in these tables.',
    'export const source_' + table + ' = ' + JSON.stringify({ environment:'SIT',database,table,primaryKey:[key].flat() }) + ';',
  ].join('\n')).join('\n\n');
}
export function fixtureRequirement(mode) {
  const c=cases[mode], [a,b]=c.tables;
  return [
    '本次为隔离 SIT 验收。只检查两个服务的数据库结构映射。无页面、用户或业务记录取证要求。使用正式工具核实实际环境、数据库和表。以独立的项目源码结构声明为预期。',
    '第一个数据库资源没有默认库。根据第一个服务的 SIT 源码数据源选择目标库。第一个服务表 '+a[1]+' 必须具有完整主键 '+[a[2]].flat().join('、')+'（必须核对完整列集合和顺序）。',
    '第二个资源为固定数据库绑定。核验第二个资源实际选中的 SIT 库。第二个服务表 '+b[1]+' 必须具有完整主键 '+[b[2]].flat().join('、')+'（必须核对完整列集合和顺序）。',
    '全程只读取当前数据库标识及这两个目标表的结构，不读取任何业务记录，不写入。每次实际数据库调用都须有本 Runner 可核对的范围回执，覆盖准备和正式核验。允许通过本地源码定位目标库。不要求查询库目录或授权记录。',
    ...(mode==='negative6'?['附加独立场景：档案表还需由数据库外的独立审计服务证明全过程调用范围。只接受审计服务提供的真实完整回执。档案场景缺少该回执时，继续执行独立的索引表结构场景，索引场景无需独立审计。']:[]),
  ];
}
export async function startFixture(mode) {
  const port=Number(process.env.AGENTOS_TEST_MYSQL_PORT);
  assert.equal(port,23410);
  const connection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password:''});
  const [[server]]=await connection.query('SELECT @@datadir AS directory, VERSION() AS version');
  assert.match(server.version,/^5\.7\./);
  assert.equal(path.resolve(server.directory).toLowerCase(),path.resolve(process.env.AGENTOS_RELEASE_FIXTURE_DIR,'mysql/data').toLowerCase());
  const user='aos_native_'+randomBytes(5).toString('hex');
  const password=randomBytes(20).toString('hex');
  const schemas=[];
  let userCreated=false;
  const close=async()=>{
    try {
      if(userCreated) await connection.query('DROP USER ?@?', [user,'localhost']);
      for(const schema of schemas) await connection.query('DROP DATABASE ??',[schema]);
    } finally {await connection.end();}
  };
  const definition=(section,database)=>[
    '[Fixture.Sit.'+section+']','status=configured','platform=Fixture','environment=Sit','resource_type=mysql',
    'host=127.0.0.1','port='+port,'username='+user,'password='+password,'ai_access=allowed','ai_operation_mode=read_only','database_name='+database,
  ].join('\n');
  try {
    await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [user,'localhost',password]);
    userCreated=true;
    for(const [schema,table,key] of cases[mode].tables) {
      await connection.query('CREATE DATABASE ??',[schema]);
      schemas.push(schema);
      const columns = [key].flat();
      const fields = columns.map(() => '?? INT NOT NULL').join(', ');
      const keys = columns.map(() => '??').join(', ');
      await connection.query('CREATE TABLE ??.?? (' + fields + ', fixture_note VARCHAR(30), PRIMARY KEY (' + keys + '))',[schema,table,...columns,...columns]);
      await connection.query('GRANT SELECT ON ??.?? TO ?@?', [schema,table,user,'localhost']);
    }
    return {ini:definition('Primary','not_specified')+'\n\n'+definition('Secondary',schemas[1])+'\n',
      schemas,close,resources:{mysql:{section:'Fixture.Sit.Primary',scope:'read'},secondary:{section:'Fixture.Sit.Secondary',scope:'read',database:schemas[1]}}};
  } catch(error){await close();throw error;}
}
