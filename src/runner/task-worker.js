import {fenceParentExit} from './parent-exit.js';
const normalDisconnect=fenceParentExit();
import { executeEnvironmentJob } from './environment-job.js';
import { executeJob } from './codex-executor.js';
import { runRequirementTest } from './requirement-test.js';
import { probeRequirementRuntime } from './requirement-probe.js';

process.once('message', async ({ job, config }) => {
  const send = (message) => new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('Runner disconnected'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });
  try {
    const execute = job.workflow === 'requirement_probe'
      ? (job, config) => probeRequirementRuntime(config.projects[job.projectId], config.dataDir, job.probe)
      : job.workflow === 'requirement_test' ? runRequirementTest
      : job.environmentAccess ? executeEnvironmentJob : executeJob;
    const result = await execute(job, config, (event) => send({ type: 'event', event }));
    await send({ type: 'result', result });
  } catch (error) {
    await send({ type: 'failure', message: error.message }).catch(() => undefined);
    process.exitCode = 1;
  } finally {normalDisconnect();if (process.connected) process.disconnect(); }
});
