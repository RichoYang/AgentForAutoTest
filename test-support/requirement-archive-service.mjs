// Independent soft-archive/search lifecycle; first execution is registered after executor freeze.
import { createServer } from 'node:http';
export async function createArchiveService(connection, database, _mode, { initialize = true, port = 0 } = {}) {
  const table = '`' + database + '`.entries';
  const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
  if (initialize) await connection.query(`CREATE TABLE ${table}(business_key VARCHAR(180) PRIMARY KEY,workspace VARCHAR(30) NOT NULL,title VARCHAR(80) NOT NULL,content TEXT NOT NULL,archived TINYINT NOT NULL,revision INT NOT NULL,note TEXT NULL) ENGINE=InnoDB`);
  const read = async key => ({ entry: (await query(`SELECT * FROM ${table} WHERE business_key=?`, [key]))[0] ?? null });
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {}, key = url.searchParams.get('key') ?? body.key;
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    requests.push({ method: req.method, path: url.pathname, key, workspace: url.searchParams.get('workspace'), body, at: new Date().toISOString() });
    try {
      if (url.pathname === '/entry' && req.method === 'GET') return send(await read(key));
      if (url.pathname === '/entry' && req.method === 'POST') {
        await query(`INSERT INTO ${table} VALUES(?,?,?, ?,0,1,NULL)`, [key, body.workspace, body.title, body.content]);
        return send(await read(key));
      }
      if (url.pathname === '/entry' && req.method === 'DELETE') { await query(`DELETE FROM ${table} WHERE business_key=?`, [key]); return send(await read(key)); }
      if (url.pathname === '/search' && req.method === 'GET') {
        const workspace = url.searchParams.get('workspace');
        return send({ workspace, entries: await query(`SELECT * FROM ${table} WHERE workspace=? AND archived=0 ORDER BY business_key`, [workspace]) });
      }
      if (['/archive', '/unarchive'].includes(url.pathname) && req.method === 'POST') {
        const old = (await read(key)).entry;
        if (!old) return send({ error: 'Not found' }, 404);
        const archived = url.pathname === '/archive' ? 1 : 0;
        if (old.archived === archived) return send({ error: 'Invalid transition' }, 409);
        await query(`UPDATE ${table} SET archived=?,revision=revision+1 WHERE business_key=?`, [archived, key]); return send(await read(key));
      }
      if (url.pathname === '/restore' && req.method === 'POST') {
        await query(`UPDATE ${table} SET workspace=?,title=?,content=?,archived=?,revision=?,note=? WHERE business_key=?`,
          [body.workspace, body.title, body.content, body.archived, body.revision, body.note, key]); return send(await read(key));
      }
      if (url.pathname === '/page' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><h1>Search entries</h1><div id="busy">Loading</div><div id="workspace"></div><div id="empty" hidden>NO_RESULTS</div><div id="keys"></div><div id="titles"></div><script>
          fetch('/search'+location.search).then(r=>r.json()).then(d=>setTimeout(()=>{
            document.querySelector('#workspace').textContent=d.workspace;
            document.querySelector('#keys').textContent=d.entries.map(x=>x.business_key).join('|');
            document.querySelector('#titles').textContent=d.entries.map(x=>x.title).join('|');
            document.querySelector('#empty').hidden=d.entries.length!==0;document.querySelector('#busy').remove();
          },100));</script>`);
      }
      send({ error: 'Unknown route' }, 404);
    } catch (error) { send({ error: error.message }, 400); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, requests,
    remaining: async () => ({ [table]: await query(`SELECT * FROM ${table}`) }),
    close: () => new Promise(resolve => server.close(resolve)) };
}
