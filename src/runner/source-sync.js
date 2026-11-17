import { syncSnapshot, verifySnapshot, restoreSnapshot } from './source-snapshot.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const policy = 'origin-ff-before-analysis-v1';
export async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'submodule.recurse=false', '-C', cwd, ...args], {
      windowsHide: true, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    return stdout.trim();
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    const failure = new Error('Git 操作失败或超时；请在本机检查 origin、分支、网络与登录。');
    failure.gitExitCode = error.code;
    if (/authenticat|credential|could not read (?:username|password)|permission denied|access denied|\b(?:401|403)\b/i.test(stderr)) {
      failure.gitFailure = 'auth_failed';
    } else if (error.killed || /could not (?:resolve|connect)|failed to connect|timed? out|connection (?:reset|refused|closed)|SSL connect|certificate|unexpected disconnect|early EOF|\b(?:429|50[0234])\b/i.test(stderr)) {
      failure.gitFailure = 'network_failed';
    } else {
      failure.gitFailure = 'sync_failed';
    }
    throw failure;
  }
}
function stop(name, reason) { throw new Error(`源码同步受阻（${name}）：${reason}。`); }
export async function repositories(project) {
  const entries = project?.analysisRepositories;
  if (!Array.isArray(entries) || !entries.length) throw new Error('请管理员在 projects.local.json 配置 analysisRepositories（每个仓库的相对 path 与 branch）。');
  const root = await realpath(project.repoPath);
  const seen = new Set();
  const result = [];
  for (const item of entries) {
    if (!item || typeof item.path !== 'string' || path.isAbsolute(item.path) || !item.path || typeof item.branch !== 'string') throw new Error('analysisRepositories 配置无效');
    const cwd = await realpath(path.resolve(root, item.path));
    const relative = path.relative(root, cwd);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || seen.has(cwd)) throw new Error('analysisRepositories 路径越界或重复');
    seen.add(cwd);
    await stat(path.join(cwd, '.git')); // Do not accidentally use an enclosing repository.
    if (await realpath(await git(cwd, ['rev-parse', '--show-toplevel'])) !== cwd) throw new Error('analysisRepositories 必须指向仓库根目录');
    await git(cwd, ['check-ref-format', `refs/heads/${item.branch}`]);
    if (item.branch === 'HEAD' || item.branch.startsWith('-')) throw new Error('analysisRepositories 必须指定真实分支');
    result.push({ cwd, path: relative.split(path.sep).join('/') || '.', branch: item.branch });
  }
  return result;
}
async function inspect(repo) {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    const location = await git(repo.cwd, ['rev-parse', '--git-path', marker]);
    const exists = await access(path.resolve(repo.cwd, location)).then(() => true, () => false);
    if (exists) stop(repo.path, '存在未结束的合并、变基、挑选提交或二分检查');
  }
  if (await git(repo.cwd, ['branch', '--show-current']) !== repo.branch) stop(repo.path, '当前分支与配置不一致（或 detached HEAD），不自动切分支');
  if (await git(repo.cwd, ['status', '--porcelain', '--untracked-files=normal'])) stop(repo.path, '存在本地修改，不自动 stash、reset 或覆盖');
  return git(repo.cwd, ['rev-parse', 'HEAD']);
}

// Only trusted local deployment configuration selects repositories/branches, never chat/model output.
export async function syncAnalysisSources(project) {
  const repos = await repositories(project);
  const report = { policy, checkedAt: null, repositories: [] };
  // Preflight every checkout before fetching or changing any checkout.
  for (const repo of repos) repo.before = await inspect(repo);
  for (const repo of repos) {
    await git(repo.cwd, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${repo.branch}`]);
    repo.target = await git(repo.cwd, ['rev-parse', 'FETCH_HEAD']);
    const counts = (await git(repo.cwd, ['rev-list', '--left-right', '--count', `${repo.before}...${repo.target}`])).split(/\s+/).map(Number);
    if (counts[0] !== 0) stop(repo.path, '本地存在未推送提交或与 origin 分叉，需要管理员处理');
  }
  for (const repo of repos) {
    if (await inspect(repo) !== repo.before) stop(repo.path, '同步过程中本地提交发生变化');
    await git(repo.cwd, ['merge', '--ff-only', '--no-edit', repo.target]);
    const commit = await inspect(repo);
    if (commit !== repo.target) stop(repo.path, '同步后提交与本次 origin 快照不一致');
    report.repositories.push({ path: repo.path, branch: repo.branch, before: repo.before, commit, changed: commit !== repo.before });
  }
  report.checkedAt = new Date().toISOString();
  return report;
}

export async function verifyAnalysisSources(project, report) {
  if (report?.policy === 'isolated-environment-source-v1') return verifySnapshot(project, report);
  if (report?.policy !== policy || !Array.isArray(report.repositories)) throw new Error('缺少本次分析的同步证据，请重新发起分析；不重跑旧任务。');
  const repos = await repositories(project);
  if (repos.length !== report.repositories.length) throw new Error('分析仓库配置已改变，请重新分析。');
  for (const repo of repos) {
    const evidence = report.repositories.find((item) => item.path === repo.path && item.branch === repo.branch);
    if (!evidence || await inspect(repo) !== evidence.commit) stop(repo.path, '源码已不同于本次分析快照，请重新分析');
  }
  return report;
}

export async function prepareAnalysisSources(job, project) {
  const report = job.analysisSourceSnapshot??[...(job.context??[])].reverse().find(entry=>entry.result?.sourceSync&&(entry.result.sourceQuestionId===undefined||entry.result.sourceQuestionId===job.questionId))?.result.sourceSync;
  if(report?.policy==='isolated-environment-source-v1'&&job.sourceEnvironment&&report.environment!==job.sourceEnvironment)throw new Error('本问题已固定其它源码环境；请新建问题明确目标环境，不混用测试与生产提交。');
  // A same-question investigation keeps one immutable source snapshot. Runtime
  // tools may add evidence between turns, but they must not trigger another
  // clone/fetch of the same 20+ repositories.
  if (report && (report.policy !== 'isolated-environment-source-v1' || !job.sourceEnvironment || report.environment === job.sourceEnvironment)) {
    try{return await verifyAnalysisSources(project, report);}catch(error){if(error.code==='ENOENT'&&report.policy==='isolated-environment-source-v1')return restoreSnapshot(project,report);throw error;}
  }
  if (job.stage !== 'owner_report') return project.analysisSourceMode === 'isolated' ? syncSnapshot({...project,id:job.projectId??project.id}, job.sourceEnvironment) : syncAnalysisSources(project);
  return verifyAnalysisSources(project, report);
}
