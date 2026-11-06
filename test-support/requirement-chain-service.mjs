// Actual isolated service used by the native acceptance Runner. All SQL below
// executes against a newly created loopback-only database owned by the harness.
// No project credentials or business services are used.
import { createServer } from 'node:http';

export async function createChainService(connection, database, mode, options = {}) {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('Invalid isolated database');
  const requests = [], pending = new Set(), lost = new Set();
  const stock = '`' + database + '`.stock', reservations = '`' + database + '`.reservations';
  const orders = '`' + database + '`.orders', approvals = '`' + database + '`.approvals';
  if (options.initialize !== false) {
  await connection.query(`CREATE TABLE ${stock} (id BIGINT PRIMARY KEY AUTO_INCREMENT, business_key VARCHAR(180) UNIQUE NOT NULL, tenant VARCHAR(24) NOT NULL, period VARCHAR(16) NOT NULL, quantity INT NOT NULL, reserved INT NOT NULL DEFAULT 0, note LONGTEXT NULL) ENGINE=InnoDB AUTO_INCREMENT=9007199254740993`);
  await connection.query(`CREATE TABLE ${reservations} (code VARCHAR(180) PRIMARY KEY, stock_key VARCHAR(180) NOT NULL, tenant VARCHAR(24) NOT NULL, quantity INT NOT NULL, created_at DATETIME(6) NOT NULL) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE ${orders} (id BIGINT PRIMARY KEY AUTO_INCREMENT, business_key VARCHAR(180) UNIQUE NOT NULL, tenant VARCHAR(24) NOT NULL, amount DECIMAL(20,4) NOT NULL, state VARCHAR(24) NOT NULL, revision INT NOT NULL DEFAULT 1, approval_note VARCHAR(180) NULL) ENGINE=InnoDB AUTO_INCREMENT=9007199254741993`);
  await connection.query(`CREATE TABLE ${approvals} (order_key VARCHAR(180) PRIMARY KEY, tenant VARCHAR(24) NOT NULL, decision VARCHAR(24) NOT NULL, decided_at DATETIME(6) NOT NULL) ENGINE=InnoDB`);
  }
  const query = async (sql, values = []) => (await connection.execute(sql, values))[0];
  const readStock = async key => {
    const rows = await query(`SELECT * FROM ${stock} WHERE business_key=?`, [key]);
    if (!rows.length) return { stock: null, reservations: [] };
    return { stock: { ...rows[0], available: rows[0].quantity - rows[0].reserved }, reservations: await query(`SELECT * FROM ${reservations} WHERE stock_key=? ORDER BY code DESC`, [key]) };
  };
  const readOrder = async key => {
    const rows = await query(`SELECT * FROM ${orders} WHERE business_key=?`, [key]);
    return { order: rows[0] ?? null, approvals: await query(`SELECT * FROM ${approvals} WHERE order_key=?`, [key]) };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const key = url.searchParams.get('key') ?? body.key;
    requests.push({ method: req.method, path: url.pathname, key, body, at: new Date().toISOString() });
    res.setHeader('content-type', 'application/json');
    const send = value => res.end(JSON.stringify(value));
    try {
      if (url.pathname === '/stock' && req.method === 'GET') return send(await readStock(key));
      if (url.pathname === '/stock' && req.method === 'POST') {
        await query(`INSERT INTO ${stock}(business_key,tenant,period,quantity,reserved,note) VALUES(?,?,?,?,0,?)`, [key, body.tenant, body.period, String(body.quantity), body.note ?? null]);
        return send(await readStock(key));
      }
      if (url.pathname === '/stock' && req.method === 'DELETE') {
        await query(`DELETE FROM ${reservations} WHERE stock_key=?`, [key]);
        await query(`DELETE FROM ${stock} WHERE business_key=?`, [key]); return send({ deleted: true });
      }
      if (url.pathname === '/reserve' && req.method === 'POST') {
        const old = await query(`SELECT * FROM ${reservations} WHERE code=?`, [body.code]);
        if (old.length) return send({ idempotent: true, ...await readStock(key) });
        const current = (await readStock(key)).stock;
        if (!current || current.tenant !== body.tenant || body.quantity <= 0 || current.available < body.quantity) {
          res.statusCode = 409; return send({ error: 'insufficient or mismatched stock' });
        }
        await connection.beginTransaction();
        try {
          const update = await query(`UPDATE ${stock} SET reserved=reserved+? WHERE business_key=? AND tenant=? AND quantity-reserved>=?`, [String(body.quantity), key, body.tenant, String(body.quantity)]);
          if (update.affectedRows !== 1) throw new Error('reservation conflict');
          await query(`INSERT INTO ${reservations} VALUES(?,?,?,?,NOW(6))`, [body.code, key, body.tenant, String(body.quantity)]);
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        if (mode === 'inventory-lost-receipt' && !lost.has(body.code)) { lost.add(body.code); return res.destroy(); }
        return send(await readStock(key));
      }
      if (url.pathname === '/reserve' && req.method === 'DELETE') {
        const old = await query(`SELECT * FROM ${reservations} WHERE code=? AND stock_key=?`, [body.code, key]);
        if (old.length) {
          await query(`UPDATE ${stock} SET reserved=reserved-? WHERE business_key=?`, [String(old[0].quantity), key]);
          await query(`DELETE FROM ${reservations} WHERE code=?`, [body.code]);
        }
        return send(await readStock(key));
      }
      if (url.pathname === '/order' && req.method === 'GET') return send(await readOrder(key));
      if (url.pathname === '/order' && req.method === 'POST') {
        await query(`INSERT INTO ${orders}(business_key,tenant,amount,state,revision) VALUES(?,?,?,'DRAFT',1)`, [key, body.tenant, String(body.amount)]);
        return send(await readOrder(key));
      }
      if (url.pathname === '/order' && req.method === 'DELETE') {
        await query(`DELETE FROM ${approvals} WHERE order_key=?`, [key]);
        await query(`DELETE FROM ${orders} WHERE business_key=?`, [key]); return send({ deleted: true });
      }
      // Test-only reversible transition endpoint: restores the original state,
      // revision and note, removes the approval side effect for this exact order.
      if (url.pathname === '/order/restore' && req.method === 'POST') {
        await query(`DELETE FROM ${approvals} WHERE order_key=?`, [key]);
        await query(`UPDATE ${orders} SET state=?,revision=?,approval_note=? WHERE business_key=?`, [body.state, String(body.revision), body.approval_note ?? null, key]);
        return send(await readOrder(key));
      }
      if (url.pathname === '/submit' && req.method === 'POST') {
        await query(`UPDATE ${orders} SET state='PENDING',revision=revision+1 WHERE business_key=? AND state='DRAFT'`, [key]);
        return send(await readOrder(key));
      }
      if (url.pathname === '/approve' && req.method === 'POST') {
        const current = (await readOrder(key)).order;
        if (!current || current.tenant !== body.tenant || !['PENDING', 'PROCESSING', 'APPROVED'].includes(current.state)) {
          res.statusCode = 409; return send({ error: 'order is not pending' });
        }
        if (current.state !== 'PENDING') return send(await readOrder(key));
        await query(`UPDATE ${orders} SET state='PROCESSING',revision=revision+1 WHERE business_key=?`, [key]);
        const work = new Promise(resolve => setTimeout(async () => {
          try {
            await query(`INSERT INTO ${approvals} VALUES(?,?,'APPROVED',NOW(6))`, [key, body.tenant]);
            await query(`UPDATE ${orders} SET state='APPROVED',revision=revision+1,approval_note=? WHERE business_key=?`, [body.note ?? null, key]);
          } finally { pending.delete(work); resolve(); }
        }, 350)); pending.add(work);
        return send(await readOrder(key));
      }
      if (url.pathname === '/page') {
        res.setHeader('content-type', 'text/html');
        const kind = url.searchParams.get('kind') === 'order' ? 'order' : 'stock';
        return res.end(`<label>编号<input id="key" value="${String(key).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></label><div id="busy">读取中</div><span id="tenant"></span><span id="period"></span><span id="value"></span><span id="state"></span><script>
          async function refresh(){const d=await fetch('/${kind}?key='+encodeURIComponent(document.querySelector('#key').value)).then(r=>r.json());
          const item=d.${kind}; if(!item||item.state==='PROCESSING'){setTimeout(refresh,50);return;}
          setTimeout(()=>{document.querySelector('#tenant').textContent=item.tenant;document.querySelector('#period').textContent=item.period||'';
          document.querySelector('#value').textContent=${kind === 'stock' ? 'item.available' : 'item.amount'};
          document.querySelector('#state').textContent=${mode === 'approval-wrong-page' ? "'PENDING'" : "item.state||''"};document.querySelector('#busy').remove();},200);}
          refresh();</script>`);
      }
      res.statusCode = 404; send({ error: 'unknown route' });
    } catch (error) { res.statusCode = 409; send({ error: error.message }); }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, requests,
    async remaining() { return Object.fromEntries(await Promise.all([stock, reservations, orders, approvals].map(async table => [table, await query('SELECT * FROM ' + table)]))); },
    async close() { await Promise.all(pending); await new Promise(resolve => server.close(resolve)); } };
}
