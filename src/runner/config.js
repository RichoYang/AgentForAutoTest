import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function runnerConfig(overrides = {}) {
  const projectsFile = overrides.projectsFile ?? process.env.AGENTOS_PROJECTS_FILE ?? './config/projects.local.json';
  let projects = overrides.projects;
  if (!projects) {
    const parsed = JSON.parse(await readFile(path.resolve(projectsFile), 'utf8'));
    projects = parsed.projects ?? {};
  }
  const concurrency = Number(overrides.concurrency ?? process.env.AGENTOS_RUNNER_CONCURRENCY ?? 3);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('AGENTOS_RUNNER_CONCURRENCY must be an integer from 1 to 8');
  // Kept as disabled compatibility fields; legacy env/overrides cannot restore a task cutoff.
  const analysisTurnTimeoutMs = 0, analysisResumeTimeoutMs = 0;
  return {
    ...(overrides.localExecutionRegistry?{localExecutionRegistry:overrides.localExecutionRegistry}:{}),
    knowledgeFile:path.resolve(overrides.knowledgeFile??process.env.AGENTOS_KNOWLEDGE_FILE??'./config/knowledge.local.json'),
    dataDir:path.resolve(overrides.dataDir??process.env.AGENTOS_DATA_DIR??'./data'),
    serverUrl: String(overrides.serverUrl ?? process.env.AGENTOS_SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    runnerId: overrides.runnerId ?? process.env.AGENTOS_RUNNER_ID ?? `runner-${process.platform}-${process.pid}`,
    runnerToken: overrides.runnerToken ?? process.env.AGENTOS_RUNNER_TOKEN ?? '',
    pollMs: Number(overrides.pollMs ?? process.env.AGENTOS_RUNNER_POLL_MS ?? 3000),
    worktreeRoot: path.resolve(overrides.worktreeRoot ?? process.env.AGENTOS_RUNNER_WORKTREE_ROOT ?? './data/worktrees'),
    executor: overrides.executor ?? process.env.AGENTOS_RUNNER_EXECUTOR ?? 'mock',
    codexBin: overrides.codexBin ?? process.env.CODEX_BIN ?? 'codex',
    concurrency,
    analysisTurnTimeoutMs,
    analysisResumeTimeoutMs,
    projectsFile:path.resolve(projectsFile),
    projects,
  };
}
