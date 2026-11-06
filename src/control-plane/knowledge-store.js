import { lstat, realpath } from 'node:fs/promises';
import {privateDirectory,protectPrivatePath} from '../shared/private-files.js';
import path from 'node:path';
import { terms } from './memory.js';

// Index and knowledge are separate from the Job/permission source of truth.
export class KnowledgeStore {
  constructor(dataDir) { this.directory = path.join(dataDir, 'knowledge'); this.hot = new Map(); }
  async open() {
    if (this.db) return this;
    if (!this.opening) this.opening = this.initialize().catch(error => { this.opening = null; throw error; });
    return this.opening;
  }
  async initialize() {
    await privateDirectory(this.directory);
    if((await lstat(this.directory)).isSymbolicLink()||path.dirname(await realpath(this.directory))!==await realpath(path.dirname(this.directory)))throw new Error('Invalid knowledge directory');
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(this.directory, 'knowledge.sqlite');
    try{if((await lstat(file)).isSymbolicLink())throw new Error('Invalid knowledge file');}catch(e){if(e.code!=='ENOENT')throw e;}
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, team TEXT NOT NULL, environment TEXT NOT NULL, topic TEXT NOT NULL,
          version INTEGER NOT NULL, status TEXT NOT NULL, verified_at INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS entries_scope ON entries(team,environment,status,verified_at);
        CREATE INDEX IF NOT EXISTS entries_topic ON entries(team,environment,topic,version);
        CREATE TABLE IF NOT EXISTS tokens (token TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(token,entry_id));
        CREATE TABLE IF NOT EXISTS captures (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS metrics (reason TEXT PRIMARY KEY, total INTEGER NOT NULL);`);
      await protectPrivatePath(file); this.db = db; return this;
    } catch (error) { db.close(); throw error; }
  }
  get(id) { const r = this.db.prepare('SELECT * FROM entries WHERE id=?').get(id); return r ? { ...JSON.parse(r.payload), status: r.status } : null; }
  latest(team, environment, topic) { const r = this.db.prepare('SELECT id FROM entries WHERE team=? AND environment=? AND topic=? ORDER BY version DESC LIMIT 1').get(team, environment, topic); return r ? this.get(r.id) : null; }
  size() { return this.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n; }
  prune(now,cutoff=now-30*86400000) {
    this.db.exec('PRAGMA secure_delete=ON');
    const removed=this.db.prepare('DELETE FROM entries WHERE verified_at<?').run(cutoff).changes;
    this.db.exec('DELETE FROM tokens WHERE entry_id NOT IN (SELECT id FROM entries)');
    this.db.prepare('DELETE FROM captures WHERE updated_at<?').run(cutoff);this.hot.clear();
    if(removed)this.db.exec('VACUUM');return removed;
  }
  put(entry, status = 'active') {
    this.hot.clear();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE entries SET status=? WHERE team=? AND environment=? AND topic=? AND status IN (\'active\',\'conflict\')')
        .run(status === 'conflict' ? 'conflict' : 'superseded', entry.team, entry.environment, entry.topic);
      this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?)').run(entry.id, entry.team, entry.environment, entry.topic, entry.version, status, entry.verifiedAt, JSON.stringify(entry));
      const insert = this.db.prepare('INSERT OR IGNORE INTO tokens VALUES(?,?)');
      for (const token of terms([entry.title, ...entry.aliases].join(' '))) insert.run(token, entry.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(entry.id);
  }
  search(team, message, limit = 6) {
    const tokens = terms(message).slice(0, 64), args = tokens.length ? tokens : [''];
    const key = JSON.stringify([team,tokens,limit]);
    if(this.hot.has(key))return this.hot.get(key).map(id=>this.get(id)).filter(Boolean);
    // ACL scope is in SQL BEFORE candidate selection. A bounded fallback supports paraphrases without token overlap.
    const rows = this.db.prepare(`SELECT e.id, COUNT(t.token) AS score FROM entries e LEFT JOIN tokens t
      ON t.entry_id=e.id AND t.token IN (${args.map(() => '?').join(',')})
      WHERE e.team=? AND e.status IN ('active','conflict') GROUP BY e.id ORDER BY score DESC,e.verified_at DESC LIMIT ?`).all(...args, team, limit);
    if(this.hot.size>=128)this.hot.delete(this.hot.keys().next().value);
    this.hot.set(key,rows.map(r=>r.id));
    return rows.map(r => this.get(r.id));
  }
  updateEvidence(entry) {
    this.hot.clear();
    this.db.prepare('UPDATE entries SET payload=? WHERE id=?').run(JSON.stringify(entry),entry.id);
  }
  scopeEntries(team) {
    return this.db.prepare("SELECT id FROM entries WHERE team=? AND status IN ('active','conflict') ORDER BY verified_at DESC LIMIT 100").all(team).map(x=>this.get(x.id));
  }
  processed(id) { return this.db.prepare('SELECT status FROM captures WHERE job_id=?').get(id)?.status; }
  mark(id, status) { this.db.prepare('INSERT OR REPLACE INTO captures VALUES(?,?,?)').run(id,status,Date.now()); }
  metric(reason) { this.db.prepare('INSERT INTO metrics VALUES(?,1) ON CONFLICT(reason) DO UPDATE SET total=total+1').run(reason); }
  overview() {
    return { counts: this.db.prepare('SELECT status,COUNT(*) AS total FROM entries GROUP BY status').all(), metrics: this.db.prepare('SELECT * FROM metrics').all(),
      entries: this.db.prepare('SELECT id,team,environment,topic,version,status,verified_at FROM entries ORDER BY verified_at DESC LIMIT 100').all().map(row=>({...row,title:this.get(row.id)?.title})) };
  }
  suspend(id) { this.hot.clear(); this.db.prepare("UPDATE entries SET status='suspended' WHERE id=?").run(id); }
  resolve(id) {
    this.hot.clear();
    const entry = this.get(id); if (!entry) throw new Error('Knowledge not found');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE entries SET status='superseded' WHERE team=? AND environment=? AND topic=?").run(entry.team,entry.environment,entry.topic);
      this.db.prepare("UPDATE entries SET status='active' WHERE id=?").run(id); this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    // Resolving a conflict NEVER advances verification time or changes evidence.
  }
  close() { this.db?.close(); this.db = null; this.opening = null; }
}
