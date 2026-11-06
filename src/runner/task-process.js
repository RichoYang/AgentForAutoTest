import {registerLocalExecution} from './local-executions.js';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerFile = fileURLToPath(new URL('./task-worker.js', import.meta.url));

// One OS process tree per leased job, including workspace setup, Codex and verification.
// No caller-supplied PID is ever accepted by this API.
export function executeTaskProcess(job, config, emit, signal, worker = workerFile) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let result;
    let failure;
    let terminationFailure;
    let outgoing = Promise.resolve();
    let termination = Promise.resolve();
    let registered;
    const abort = () => { termination = (async()=>{const guard=await registered;if(guard)await guard.close();else await terminateTree(child);})().catch((error) => {
      terminationFailure = error;
      const uncertain = new Error(`停止无法确认：${error.message}`);
      uncertain.processesExited = false;
      reject(uncertain); // Do not wait forever if the OS refuses termination.
    }); };
    signal.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', () => {}); // Worker errors return over IPC; never broadcast raw stderr.
    child.on('message', (message) => {
      if (message.type === 'event') outgoing = outgoing.then(() => emit(message.event)).catch(() => undefined);
      if (message.type === 'result') result = message.result;
      if (message.type === 'failure') failure = new Error(message.message);
    });
    child.once('error', (error) => { failure = error; });
    child.once('close', async (code) => {
      signal.removeEventListener('abort', abort);
      await termination;
      const guard=await registered?.catch(()=>null);await guard?.close();
      await outgoing;
      if (signal.aborted) {
        const error = new Error(terminationFailure ? `停止无法确认：${terminationFailure.message}` : 'Task process tree stopped');
        error.processesExited = !terminationFailure;
        return reject(error);
      }
      if (failure || code !== 0 || !result) return reject(failure ?? new Error(`Task worker exited ${code} without result`));
      resolve(result);
    });
    registered=registerLocalExecution(config.localExecutionRegistry,job,child.pid);
    registered.then(()=>{if(!signal.aborted&&child.connected)child.send({job,config});}).catch(error=>{failure=error;child.kill();});
    if (signal.aborted) abort();
  });
}

async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Task process tree termination returned ${code}`)));
    });
  } else {
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    kill('SIGKILL'); // Also stop descendants that ignored SIGTERM after their parent exited.
  }
}
