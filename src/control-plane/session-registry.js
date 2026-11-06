import { readFile, mkdir, rename } from 'node:fs/promises';
import {writePrivateFile} from '../shared/private-files.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
// One app-server owner. A pending turn after a crash is uncertain, never automatically replayed in the same thread.
export class SessionRegistry {
  constructor(dataDir) { this.file = path.join(dataDir, 'codex-conversations.json'); this.queue = Promise.resolve(); }
  async read() {
    try { const value = JSON.parse(await readFile(this.file, 'utf8')); if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) throw new Error('Invalid session registry'); return value; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, sessions: {} }; if (error instanceof SyntaxError) throw new Error('Invalid session registry; original file preserved'); throw error; }
  }
  async get(key) { return (await this.read()).sessions[hash(key)]; }
  async prune(cutoff,protectedRequests=new Set()) {
    const run=this.queue.then(async()=>{try{if((await (await import('node:fs/promises')).lstat(this.file)).isSymbolicLink())throw new Error('Invalid session registry file');}catch(e){if(e.code!=='ENOENT')throw e;}const data=await this.read();let removed=0;for(const [key,s]of Object.entries(data.sessions))if(Date.parse(s.updatedAt)<cutoff&&!protectedRequests.has(s.pending)){delete data.sessions[key];removed++;}
      if(removed){const tmp=this.file+'.'+process.pid+'.tmp';await writePrivateFile(tmp,JSON.stringify(data));await rename(tmp,this.file);}return removed;});this.queue=run.catch(()=>{});return run;
  }
  async set(key, value) {
    const run = this.queue.then(async () => {
      const data = await this.read(); data.sessions[hash(key)] = value;
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writePrivateFile(tmp, JSON.stringify(data)); await rename(tmp, this.file);
    });
    this.queue = run.catch(() => {}); return run;
  }
}
