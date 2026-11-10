import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digest, RequirementWait } from './requirement-feishu.js';

const exec = promisify(execFile);

export async function command(program, args, options = {}) {
  const { stdout } = await exec(program, args, {
    ...options, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function writeJson(file, data) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file).catch(async error => { await unlink(temporary).catch(() => {}); throw error; });
}

export async function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new RequirementWait('project_defaults', '任务输出目录必须为绝对路径。');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new RequirementWait('project_defaults', '任务输出目录不能是符号链接。');
  return realpath(directory);
}

export async function readRequirementWithInputs(client, url, directories, workDir) {
  const source = await client.readRequirement(url);
  if (!Object.keys(directories).length) return source;
  const [supplements, developerFeedback] = await Promise.all([
    readMarkdownInputs(directories.supplementDirectory, true),
    readMarkdownInputs(directories.developerDirectory, false),
  ]);
  const inputs = { supplements, developerFeedback };
  const images = [];
  if (directories.supplementDirectory) {
    const entries = await readdir(directories.supplementDirectory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (/\.md$/i.test(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!workDir || !entry.isFile() || !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        throw new RequirementWait('requirement_source', '未读补充材料：' + entry.name + '。请提供 Markdown 正文或 PNG／JPEG／WebP 图片。');
      }
      const buffer = await readFile(path.join(directories.supplementDirectory, entry.name));
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const anchor = 'supplement-image-' + digest(entry.name).slice(0, 20);
      const filename = anchor + '-' + sha256.slice(0, 12) + ext;
      const handle = await open(path.join(workDir, filename), 'wx', 0o600).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (handle) try { await handle.writeFile(buffer); } finally { await handle.close(); }
      const copied = path.join(workDir, filename);
      if (!(await lstat(copied)).isFile() || createHash('sha256').update(await readFile(copied)).digest('hex') !== sha256) {
        throw new RequirementWait('requirement_source', '本机补充材料副本校验失败：' + entry.name);
      }
      images.push({ anchor, type: 'supplement-image', name: entry.name, filename, sha256 });
    }
  }
  const legacyHash = source.legacyHash || images.length ? digest([source.legacyHash ?? source.hash, inputs]) : undefined;
  const materials = [...(source.materials ?? []), ...images];
  return { ...source, ...inputs,
    ...(materials.length ? { materials, legacyHash } : {}),
    hash: images.length ? digest([source.hash, inputs, images]) : digest([source.hash, inputs]) };
}

async function readMarkdownInputs(directory, withAnchors) {
  if (!directory) return [];
  if (path.relative(directory, await realpath(directory))) {
    throw new RequirementWait('requirement_source', '补充材料目录不能经由链接重定向。');
  }
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.md$/i.test(entry.name)).map(entry => entry.name).sort();
  if (!files.length && !withAnchors) throw new RequirementWait('requirement_source', '指定的开发反馈目录没有可读取的 Markdown 文件。');
  return Promise.all(files.map(async name => {
    const body = await readFile(path.join(directory, name), 'utf8');
    if (!withAnchors) return { name, body };
    const sections = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)];
    if (!sections.length) sections.push(Object.assign([name, name], { index: 0 }));
    return { name, sections: sections.map((section, index) => ({
      anchor: 'local-' + digest([name, index, section[1]]).slice(0, 20),
      title: section[1].trim(), text: body.slice(section.index, sections[index + 1]?.index).trim(),
    })) };
  }));
}

export async function loadSkill(spec, expectedName, relatives) {
  if (!spec || !path.isAbsolute(spec.path) || !/^[a-f0-9]{64}$/.test(spec.sha256)) {
    throw new RequirementWait('skill_version', '未配置 ' + expectedName + ' 的绝对路径和文件指纹。');
  }
  const files = {};
  const hash = createHash('sha256');
  for (const relative of ['SKILL.md', ...relatives]) {
    const contents = await readFile(path.join(spec.path, relative));
    hash.update(relative).update('\0').update(contents).update('\0');
    if (/\.(?:md|json)$/.test(relative)) files[relative] = contents.toString('utf8');
  }
  if (!files['SKILL.md'].includes('name: ' + expectedName) || hash.digest('hex') !== spec.sha256) {
    throw new RequirementWait('skill_version', '本机 Skill 或引用文件版本与配置不符：' + expectedName);
  }
  return { ...spec, files };
}

export const generatorReferences = ['references/case-schema.md', 'scripts/publish_lark_testcases.ps1'];
export const regressionReferences = ['references/execution-standard.md', 'references/report-contract.md',
  'references/report-schema-v1.json', 'scripts/build-full-regression-report.mjs', 'assets/full-regression-report-template-v1.xlsx'];

export async function sourceBaseline(project) {
  if (!path.isAbsolute(project.repoPath ?? '')) throw new RequirementWait('repository', '项目根仓路径必须为绝对路径。');
  const root = await realpath(project.repoPath);
  const repos = project.analysisRepositories ?? [{ path: '.', branch: project.baseBranch }];
  return Promise.all(repos.map(async (repository, index) => {
    const branch = repository.branch;
    if (!repository.path || !branch || branch.startsWith('-')) throw new RequirementWait('repository', '项目仓库路径或分支未明确。');
    const folder = await realpath(path.resolve(root, repository.path));
    const relative = path.relative(root, folder);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new RequirementWait('repository', '配置中的源码目录离开已绑定项目。');
    }
    const git = args => command('git', ['-C', folder, ...args]).then(value => value.trim());
    if (path.relative(folder, await realpath(await git(['rev-parse', '--show-toplevel']))) !== '') {
      throw new RequirementWait('repository', '配置中的子仓目录并非独立 Git 仓库。');
    }
    const commit = await git(['rev-parse', '--verify', 'refs/heads/' + branch + '^{commit}']);
    const remote = await git(['rev-parse', '--verify', 'refs/remotes/origin/' + branch + '^{commit}']).catch(() => '');
    return {
      repository_id: 'repo-' + (index + 1), name: path.basename(folder), path_or_url: folder,
      branch, commit, remote_baseline: remote || '无本地远端跟踪引用',
      worktree_commit: await git(['rev-parse', '--verify', 'HEAD^{commit}']),
      worktree_branch: await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'detached HEAD'),
      dirty_status: await git(['status', '--porcelain', '--untracked-files=no']).then(value => value ? '存在本机改动' : '无已跟踪文件改动'),
      deployment_verification: '本机源码记录，实际部署由 SIT 部署指纹核验。',
    };
  }));
}
