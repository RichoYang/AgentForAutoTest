// New held-out business semantics: immutable content revisions and a mutable
// publication pointer. Uses only the dedicated database and loopback HTTP.
import { createServer } from 'node:http';

export async function createPublicationService(connection, database, _mode, options = {}) {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('Invalid isolated database');
  const documents = '`' + database + '`.documents', revisions = '`' + database + '`.revisions';
  const requests = [], query = async (sql, args = []) => (await connection.execute(sql, args))[0];
  if (options.initialize !== false) {
    await connection.query(`CREATE TABLE ${documents}(id BIGINT PRIMARY KEY AUTO_INCREMENT,business_key VARCHAR(180) UNIQUE NOT NULL,title VARCHAR(100) NOT NULL,active_revision VARCHAR(180) NOT NULL) ENGINE=InnoDB AUTO_INCREMENT=9007199254740993`);
    await connection.query(`CREATE TABLE ${revisions}(business_key VARCHAR(180) PRIMARY KEY,document_key VARCHAR(180) NOT NULL,body TEXT NOT NULL,created_at DATETIME(6) NOT NULL) ENGINE=InnoDB`);
  }
  async function read(key) {
    return { document: (await query(`SELECT * FROM ${documents} WHERE business_key=?`, [key]))[0] ?? null,
      revisions: await query(`SELECT * FROM ${revisions} WHERE document_key=? ORDER BY business_key DESC`, [key]) };
  }
  async function render(key, revision) {
    const record = await read(key), selected = revision ?? record.document?.active_revision;
    const content = record.revisions.find(item => item.business_key === selected);
    return { key, version: selected ?? null, mode: revision ? 'preview' : 'live', content: content?.body ?? null };
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let raw = ''; for await (const chunk of request) raw += chunk;
    response.setHeader('content-type', 'application/json');
    const send = value => response.end(JSON.stringify(value));
    try {
      const body = raw ? JSON.parse(raw) : {}, key = url.searchParams.get('key') ?? body.key;
      requests.push({ method: request.method, path: url.pathname, key, body, at: new Date().toISOString() });
      if (url.pathname === '/document' && request.method === 'GET') return send(await read(key));
      if (url.pathname === '/bundle' && request.method === 'POST') {
        await connection.beginTransaction();
        try {
          await query(`INSERT INTO ${documents}(business_key,title,active_revision) VALUES(?,?,?)`, [key, body.title, body.first_version]);
          await query(`INSERT INTO ${revisions} VALUES(?,?,?,NOW(6)),(?,?,?,NOW(6))`, [body.first_version, key, body.first_content, body.draft_version, key, body.draft_content]);
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        return send(await read(key));
      }
      if (url.pathname === '/bundle' && request.method === 'DELETE') {
        await query(`DELETE FROM ${revisions} WHERE document_key=?`, [key]);
        await query(`DELETE FROM ${documents} WHERE business_key=?`, [key]); return send(await read(key));
      }
      if (url.pathname === '/publish' && request.method === 'POST') {
        const record = await read(key);
        if (!record.document || !record.revisions.some(item => item.business_key === body.version)) {
          response.statusCode = 409; return send({ error: 'Revision is not owned by this document' });
        }
        await query(`UPDATE ${documents} SET active_revision=? WHERE business_key=?`, [body.version, key]);
        return send(await read(key));
      }
      if (url.pathname === '/render' && request.method === 'GET') return send(await render(key, url.searchParams.get('version')));
      if (url.pathname === '/read' && request.method === 'GET') {
        response.setHeader('content-type', 'text/html');
        return response.end(`<div id="busy">Loading</div><span id="key"></span><span id="version"></span><span id="mode"></span><article id="content"></article><script>
          fetch('/render'+location.search).then(r=>r.json()).then(d=>setTimeout(()=>{
            for(const name of ['key','version','mode','content'])document.querySelector('#'+name).textContent=d[name]??'';
            document.querySelector('#busy').remove();},100));</script>`);
      }
      response.statusCode = 404; send({ error: 'Unknown route' });
    } catch (error) { response.statusCode = 409; send({ error: error.message }); }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, requests,
    async remaining() { return Object.fromEntries(await Promise.all([documents, revisions].map(async table => [table, await query('SELECT * FROM ' + table)]))); },
    async close() { await new Promise(resolve => server.close(resolve)); } };
}
