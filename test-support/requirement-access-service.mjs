// Held-out isolated service. Created after executor freeze; no executor-specific
// plans or review overrides. All effects are confined to this fresh database.
import { createServer } from 'node:http';

export async function createAccessService(connection, database, _mode, options = {}) {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('Invalid isolated database');
  const documents = '`' + database + '`.documents', grants = '`' + database + '`.grants';
  const requests = [];
  const query = async (sql, args = []) => (await connection.execute(sql, args))[0];
  if (options.initialize !== false) {
    await connection.query(`CREATE TABLE ${documents}(id BIGINT PRIMARY KEY AUTO_INCREMENT, business_key VARCHAR(180) UNIQUE NOT NULL, tenant VARCHAR(24) NOT NULL, title VARCHAR(100) NOT NULL) ENGINE=InnoDB AUTO_INCREMENT=9007199254740993`);
    await connection.query(`CREATE TABLE ${grants}(business_key VARCHAR(180) PRIMARY KEY, document_key VARCHAR(180) NOT NULL, tenant VARCHAR(24) NOT NULL, principal VARCHAR(180) NOT NULL, active INT NOT NULL, expires_at DATETIME(6) NULL, UNIQUE(document_key,principal)) ENGINE=InnoDB`);
  }
  async function readDocument(key) {
    return { document: (await query(`SELECT * FROM ${documents} WHERE business_key=?`, [key]))[0] ?? null,
      grants: await query(`SELECT * FROM ${grants} WHERE document_key=? ORDER BY business_key DESC`, [key]) };
  }
  async function access(key, tenant, principal) {
    const document = (await query(`SELECT * FROM ${documents} WHERE business_key=? AND tenant=?`, [key, tenant]))[0];
    const grant = (await query(`SELECT * FROM ${grants} WHERE document_key=? AND tenant=? AND principal=?`, [key, tenant, principal]))[0];
    const allowed = Boolean(document && grant?.active === 1 && (grant.expires_at === null || Date.parse(grant.expires_at) > Date.now()));
    return { key, tenant, principal, allowed, reason: allowed ? 'GRANTED' : 'DENIED', title: allowed ? document.title : null };
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let raw = ''; for await (const chunk of request) raw += chunk;
    response.setHeader('content-type', 'application/json');
    const send = value => response.end(JSON.stringify(value));
    try {
      const body = raw ? JSON.parse(raw) : {}, key = url.searchParams.get('key') ?? body.key;
      requests.push({ method: request.method, path: url.pathname, key, body, at: new Date().toISOString() });
      if (url.pathname === '/document' && request.method === 'GET') return send(await readDocument(key));
      if (url.pathname === '/document' && request.method === 'POST') {
        await query(`INSERT INTO ${documents}(business_key,tenant,title) VALUES(?,?,?)`, [key, body.tenant, body.title]);
        return send(await readDocument(key));
      }
      if (url.pathname === '/document' && request.method === 'DELETE') {
        await query(`DELETE FROM ${grants} WHERE document_key=?`, [key]);
        await query(`DELETE FROM ${documents} WHERE business_key=?`, [key]);
        return send(await readDocument(key));
      }
      if (url.pathname === '/grant' && request.method === 'GET') return send({ grant: (await query(`SELECT * FROM ${grants} WHERE business_key=?`, [key]))[0] ?? null });
      if (url.pathname === '/grant' && request.method === 'POST') {
        const document = (await readDocument(body.document_key)).document;
        if (!document || document.tenant !== body.tenant) { response.statusCode = 409; return send({ error: 'Document tenant mismatch' }); }
        await query(`INSERT INTO ${grants} VALUES(?,?,?,?,1,NULL)`, [key, body.document_key, body.tenant, body.principal]);
        return send({ grant: (await query(`SELECT * FROM ${grants} WHERE business_key=?`, [key]))[0] });
      }
      if (url.pathname === '/grant' && request.method === 'PATCH') {
        if (![0, 1].includes(body.active)) { response.statusCode = 400; return send({ error: 'active must be 0 or 1' }); }
        await query(`UPDATE ${grants} SET active=? WHERE business_key=?`, [body.active, key]);
        return send({ grant: (await query(`SELECT * FROM ${grants} WHERE business_key=?`, [key]))[0] ?? null });
      }
      if (url.pathname === '/grant' && request.method === 'DELETE') {
        await query(`DELETE FROM ${grants} WHERE business_key=?`, [key]); return send({ grant: null });
      }
      if (url.pathname === '/access' && request.method === 'GET') {
        const result = await access(key, url.searchParams.get('tenant'), url.searchParams.get('principal'));
        response.statusCode = result.allowed ? 200 : 403; return send(result);
      }
      if (url.pathname === '/view' && request.method === 'GET') {
        response.setHeader('content-type', 'text/html');
        return response.end(`<div id="busy">Loading</div><span id="key"></span><span id="tenant"></span><span id="principal"></span><span id="decision"></span><span id="title"></span><script>
          fetch('/access'+location.search).then(r=>r.json()).then(d=>setTimeout(()=>{
            for(const name of ['key','tenant','principal'])document.querySelector('#'+name).textContent=d[name];
            document.querySelector('#decision').textContent=d.allowed?'GRANTED':'DENIED';document.querySelector('#title').textContent=d.title??'';
            document.querySelector('#busy').remove();},120));</script>`);
      }
      response.statusCode = 404; send({ error: 'Unknown route' });
    } catch (error) { response.statusCode = 409; send({ error: error.message }); }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, requests,
    async remaining() { return Object.fromEntries(await Promise.all([documents, grants].map(async table => [table, await query('SELECT * FROM ' + table)]))); },
    async close() { await new Promise(resolve => server.close(resolve)); } };
}
