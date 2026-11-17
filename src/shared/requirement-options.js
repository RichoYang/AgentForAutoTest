import path from 'node:path';
import { createHash } from 'node:crypto';

export function requirementTopicFingerprint(project) {
  return createHash('sha256').update(JSON.stringify(project)).digest('hex');
}

export function matchesRequirementTopic(project, job) {
  const bindings = project.requirementTest.topicBindings;
  if (!bindings) return job.requirement.topicBinding === undefined;
  return job.requirement.topicBinding === requirementTopicFingerprint(project)
    && bindings.some(binding => binding.chatId === job.chatId && binding.rootId === job.requirement.root
      && binding.documentUrl === job.requirement.url);
}

export function requirementCleanupAfterCancellation(job) {
  return job.requirement?.cleanupOnly === true && (job.requirement.cleanupAfterCancellation
    ?? job.events?.some(event => event.type === 'cancelled' && event.processesExited) ?? false);
}

const inputLabels = { supplementDirectory: '补充目录', developerDirectory: '开发反馈' };
const messageLabels = {
  document: '需求文档|主需求', supplements: '补充文档|参考文档', caseSource: '测试用例',
  branch: '分支名称|测试分支', localSupplement: '本地补充', supplementNotes: '补充说明',
  task: '需求内容', authorization: '准许内容|允许内容', notes: '备注内容', environment: '执行环境|测试环境|环境',
  projectFolderUrl: '用例存放|用例目录', reportDirectory: '输出路径|结果路径',
  ...inputLabels,
};

export function requirementLinks(content, domain) {
  return [...new Set([...String(content ?? '').matchAll(/https:\/\/[a-z0-9.-]+\/(?:docx|wiki)\/[A-Za-z0-9]+/gi)]
    .map(([value]) => new URL(value)).filter(url => url.hostname === domain).map(url => url.href))];
}

export function requirementOptions(content, domain) {
  const text = String(content ?? '');
  const options = {};
  const labels = new Map(Object.entries(messageLabels).flatMap(([key, names]) => names.split('|').map(name => [name, key])));
  const boundary = /\r?\n/.test(text) ? '^' : '(?:^|(?<=\\s))';
  const parts = [...text.matchAll(new RegExp(boundary + '[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?(' + [...labels.keys()].join('|')
    + ')[ \\t]*(?:\\*\\*)?[:：](?:\\*\\*)?[ \\t]*', 'gm'))];
  const fields = new Map();
  for (const [index, part] of parts.entries()) {
    const key = labels.get(part[1]);
    const value = text.slice(part.index + part[0].length, parts[index + 1]?.index).trim();
    const values = fields.get(key) ?? new Set();
    values.add(value);
    fields.set(key, values);
  }
  for (const [key, values] of fields) {
    if (values.size > 1 && !['document', 'supplements'].includes(key) || values.has('')) {
      throw new Error('请为「' + messageLabels[key].split('|')[0] + '」填写明确内容。');
    }
    options[key] = [...values].join('\n');
  }
  delete options.environment;
  if (options.supplements && path.isAbsolute(options.supplements)) {
    options.supplementDirectory ??= options.supplements;
    delete options.supplements;
  }
  if (domain) {
    const references = value => value.split(/\r?\n/).map(line => line.replace(/^[\s*\-]+/, '').trim()).filter(Boolean)
      .flatMap(line => {
        const links = requirementLinks(line, domain);
        if (links.length) return links;
        if (/https?:\/\//i.test(line)) throw new Error('需求和补充文档须为本租户的飞书文档链接或准确标题。');
        return [line];
      });
    const supplements = options.supplements ? references(options.supplements) : [];
    if (options.caseSource) {
      const urls = [...new Set(options.caseSource.match(/https:\/\/[a-z0-9.-]+\/(?:sheets|wiki)\/[A-Za-z0-9]+/gi) ?? [])];
      if (urls.length > 1) throw new Error('「测试用例」请指定一份原表。');
      if (urls.length) options.caseSource = urls[0];
    }
    const candidates = requirementLinks(text, domain).filter(url => url !== options.caseSource);
    const explicit = options.document ? references(options.document) : [];
    const main = explicit.shift() ?? candidates.find(url => !supplements.includes(url));
    delete options.document;
    delete options.supplements;
    if (main) {
      if (requirementLinks(main, domain).length) options.documentUrl = main;
      else options.documentTitle = main;
    }
    const supporting = [...new Set([...explicit, ...supplements, ...candidates])].filter(value => value !== main);
    if (supporting.length) options.supplementDocuments = supporting;
  }
  const tiers = new Set([...text.matchAll(/(?:^\s*(?:执行环境|测试环境|环境)\s*[:：]\s*|(?:在|使用|切换到)\s*)(UAT\b|SIT\b|PRD\b|PROD(?:UCTION)?\b|生产(?=环境|测试|\s|$)|测试环境)/gim)]
    .map(match => match[1].toUpperCase()));
  if (tiers.size > 1) throw new Error('请指定一个明确的测试环境。');
  if (tiers.size) options.requestedEnvironment = [...tiers][0];
  return options;
}

function folderUrl(value, domain) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.host !== domain || url.username || url.password
    || !/^\/drive\/folder\/[A-Za-z0-9]+\/?$/.test(url.pathname)) throw new Error('请提供本租户的飞书用例目录。');
  return url.origin + url.pathname.replace(/\/$/, '');
}

function directoryKey(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) return null;
  const normalized = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function resolveRequirementOptions(settings, options = {}) {
  const { requestedEnvironment, projectFolderUrl, reportDirectory, ...inputs } = options;
  if (requestedEnvironment && (!['SIT', 'UAT', '测试环境'].includes(requestedEnvironment)
    || !['SIT', 'UAT'].includes(settings.environment?.name)
    || ![settings.environment.name, '测试环境', ...(settings.environment.aliases ?? [])].includes(requestedEnvironment))) {
    throw new Error('该名称未绑定本项目的测试环境，请核对环境配置。');
  }
  const resolved = { ...settings, requestedEnvironment };
  if (projectFolderUrl) {
    const canonical = folderUrl(projectFolderUrl, settings.document.domain);
    if (![settings.projectFolderUrl, ...(settings.allowedProjectFolderUrls ?? [])].filter(Boolean)
      .some(value => folderUrl(value, settings.document.domain) === canonical)) {
      throw new Error('用例目录未登记到本项目。');
    }
    resolved.projectFolderUrl = canonical;
    resolved.explicitProjectFolder = true;
  }
  if (reportDirectory) resolved.reportDirectory = approvedDirectory(reportDirectory,
    [settings.reportDirectory, ...(settings.allowedReportDirectories ?? [])], '结果路径');
  resolved.inputDirectories = Object.fromEntries(Object.entries(inputLabels).filter(([key]) => inputs[key])
    .map(([key, label]) => [key, approvedDirectory(inputs[key], settings.allowedInputDirectories ?? [], label)]));
  if (options.localSupplement) {
    const candidate = directoryKey(options.localSupplement);
    if (!candidate || !/\.md$/i.test(candidate)) throw new Error('本地补充须为项目材料目录内的 Markdown 绝对路径。');
    const file = path.normalize(options.localSupplement);
    const eligible = (settings.allowedInputDirectories ?? []).filter(directoryKey)
      .filter(directory => {
        const relative = path.relative(path.normalize(directory), file);
        return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
      });
    if (!eligible.length) throw new Error('本地补充超出项目已登记的材料目录。');
    resolved.localSupplement = { file, root: path.normalize(eligible[0]) };
  }
  if (options.branch && (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(options.branch)
    || /\.\.|\/\.|\/\/|\.lock(?:\/|$)|[/.]$/.test(options.branch))) {
    throw new Error('分支名称必须是明确的 Git 分支名。');
  }
  resolved.request = Object.fromEntries(['documentTitle', 'supplementDocuments', 'caseSource', 'branch', 'task', 'supplementNotes', 'authorization', 'notes']
    .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
  if (/Codex.{0,24}(?:侧边栏|内置|自带).{0,12}浏览器/i.test(options.notes ?? '')
    && /仅|只|不允许|禁止/.test(options.notes)) resolved.request.browser = 'codex_sidebar';
  if (/通过或不通过|通过或失败/.test(options.authorization ?? '')) resolved.request.resultFormat = 'binary';
  return resolved;
}

function approvedDirectory(value, allowed, label) {
  const key = directoryKey(value);
  const directory = key && allowed.find(candidate => directoryKey(candidate) === key);
  if (!directory) throw new Error(label + '未登记为本项目的绝对路径。');
  return path.normalize(directory);
}
