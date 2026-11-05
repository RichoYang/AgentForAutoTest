import { lstat, readFile, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/shared/store.js';
import { processAbsent } from '../src/runner/local-executions.js';

const [dataDir, jobId, confirmation] = process.argv.slice(2);
if (!dataDir || !path.isAbsolute(dataDir) || !/^JOB-[a-zA-Z0-9-]+$/.test(jobId ?? '')
  || confirmation !== '--instance-and-process-tree-stopped') {
  throw new Error('Usage: node scripts/recover-requirement-job.mjs <absolute-data-dir> <job-id> --instance-and-process-tree-stopped');
}
const store = new JsonStore(path.join(dataDir, 'agentos.json'));
const job = await store.getJob(jobId);
if (!job || job.workflow !== 'requirement_test' || !['running', 'cancelling'].includes(job.status) || !job.lease) {
  throw new Error('Task is not an interrupted requirement-test lease');
}
const registry = path.join(dataDir, 'local-executions');
const entries = [];
for (const file of (await readdir(registry)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
  const full = path.join(registry, file);
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) continue;
  const entry = JSON.parse(await readFile(full, 'utf8'));
  if (entry.jobId === job.id && entry.leaseId === job.lease.id && entry.runnerId === job.lease.runnerId) entries.push(entry);
}
const proof = entries[0];
if (entries.length !== 1 || proof.version !== 1 || proof.host !== hostname() || proof.platform !== process.platform
  || ![proof.ownerPid, proof.workerPid].every(pid => Number.isSafeInteger(pid) && pid > 1 && processAbsent(pid))
  || (process.platform !== 'win32' && !processAbsent(-proof.workerPid))) {
  throw new Error('Previous Runner or worker exit could not be confirmed from its local registry');
}
await store.transact(state => {
  const current = state.jobs.find(candidate => candidate.id === jobId);
  if (current?.lease?.id !== job.lease.id || current.status !== job.status) throw new Error('Lease changed during recovery');
  const cancelled = current.events.some(event => event.type === 'cancel_requested');
  current.status = current.requirement.stopMode === 'pause' ? 'paused' : cancelled ? 'cancelled' : 'awaiting_clarification';
  current.updatedAt = new Date().toISOString();
  current.lease = null;
  current.events.push({ type: cancelled ? 'cancelled' : 'failed', at: current.updatedAt,
    processesExited: true, recoveredAfterExecutorExit: true });
  current.result = { outcome: 'needs_clarification', requirementWait: 'executor_exit',
    finalMessage: '已核对旧执行进程退出并保留检查点。请在原话题 @ 专员并回复'
      + (current.status === 'cancelled' ? '“恢复清理”。' : '“继续测试”或“恢复清理”。') };
});
console.log('Recovered the interrupted lease. The checkpoint and shared resource fence are preserved.');
