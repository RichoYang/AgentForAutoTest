// Independent redemption/idempotency service; register its first run against a frozen executor.
import { createServer } from 'node:http';

export async function createCouponService(connection, database, _mode, options = {}) {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('Invalid isolated database');
  const coupons = '`' + database + '`.coupons', receipts = '`' + database + '`.receipts';
  const requests = [], query = async (sql, args = []) => (await connection.execute(sql, args))[0];
  if (options.initialize !== false) {
    await connection.query(`CREATE TABLE ${coupons}(business_key VARCHAR(180) PRIMARY KEY,owner VARCHAR(80) NOT NULL,state VARCHAR(20) NOT NULL,remaining_uses INT NOT NULL,note TEXT NULL) ENGINE=InnoDB`);
    await connection.query(`CREATE TABLE ${receipts}(request_key VARCHAR(180) PRIMARY KEY,coupon_key VARCHAR(180) UNIQUE NOT NULL,owner VARCHAR(80) NOT NULL,issued_at DATETIME(6) NOT NULL) ENGINE=InnoDB`);
  }
  async function read(key) {
    return { coupon: (await query(`SELECT * FROM ${coupons} WHERE business_key=?`, [key]))[0] ?? null,
      receipts: await query(`SELECT * FROM ${receipts} WHERE coupon_key=? ORDER BY request_key`, [key]) };
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); let raw = ''; for await (const chunk of request) raw += chunk;
    response.setHeader('content-type', 'application/json'); const send = value => response.end(JSON.stringify(value));
    try {
      const body = raw ? JSON.parse(raw) : {}, key = url.searchParams.get('key') ?? body.key;
      requests.push({ method: request.method, path: url.pathname, key, body, at: new Date().toISOString() });
      if (url.pathname === '/coupon' && request.method === 'GET') return send(await read(key));
      if (url.pathname === '/coupon' && request.method === 'POST') {
        await query(`INSERT INTO ${coupons} VALUES(?,?,'ISSUED',1,NULL)`, [key, body.owner]); return send(await read(key));
      }
      if (url.pathname === '/coupon' && request.method === 'DELETE') {
        await query(`DELETE FROM ${receipts} WHERE coupon_key=?`, [key]);
        await query(`DELETE FROM ${coupons} WHERE business_key=?`, [key]); return send(await read(key));
      }
      if (url.pathname === '/redeem' && request.method === 'POST') {
        await connection.beginTransaction();
        try {
          const coupon = (await query(`SELECT * FROM ${coupons} WHERE business_key=? FOR UPDATE`, [key]))[0];
          const existing = (await query(`SELECT * FROM ${receipts} WHERE coupon_key=?`, [key]))[0];
          if (!coupon || coupon.owner !== body.owner) throw new Error('Coupon ownership mismatch');
          if (existing && existing.request_key !== body.request_key) throw new Error('Coupon already redeemed under a different request');
          if (!existing) {
            if (coupon.state !== 'ISSUED' || coupon.remaining_uses !== 1) throw new Error('Coupon cannot be redeemed');
            await query(`INSERT INTO ${receipts} VALUES(?,?,?,NOW(6))`, [body.request_key, key, body.owner]);
            await query(`UPDATE ${coupons} SET state='REDEEMED',remaining_uses=0 WHERE business_key=?`, [key]);
          }
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        return send(await read(key));
      }
      // Test-only restoration accepts the saved exact state and optional receipt.
      if (url.pathname === '/restore' && request.method === 'POST') {
        await connection.beginTransaction();
        try {
          await query(`DELETE FROM ${receipts} WHERE coupon_key=?`, [key]);
          if (body.receipt) await query(`INSERT INTO ${receipts} VALUES(?,?,?,?)`, [body.receipt.request_key, key, body.receipt.owner, body.receipt.issued_at]);
          await query(`UPDATE ${coupons} SET owner=?,state=?,remaining_uses=?,note=? WHERE business_key=?`, [body.owner, body.state, String(body.remaining_uses), body.note ?? null, key]);
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        return send(await read(key));
      }
      if (url.pathname === '/page' && request.method === 'GET') {
        response.setHeader('content-type', 'text/html');
        return response.end(`<div id="busy">Loading</div><span id="key"></span><span id="owner"></span><span id="state"></span><span id="remaining"></span><span id="receipt"></span><script>
          fetch('/coupon'+location.search).then(r=>r.json()).then(d=>setTimeout(()=>{
            const c=d.coupon;document.querySelector('#key').textContent=c?.business_key??'';document.querySelector('#owner').textContent=c?.owner??'';
            document.querySelector('#state').textContent=c?.state??'';document.querySelector('#remaining').textContent=c?.remaining_uses??'';
            document.querySelector('#receipt').textContent=d.receipts[0]?.request_key??'';document.querySelector('#busy').remove();},100));</script>`);
      }
      response.statusCode = 404; send({ error: 'Unknown route' });
    } catch (error) { response.statusCode = 409; send({ error: error.message }); }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, requests,
    async remaining() { return Object.fromEntries(await Promise.all([coupons, receipts].map(async table => [table, await query('SELECT * FROM ' + table)]))); },
    async close() { await new Promise(resolve => server.close(resolve)); } };
}
