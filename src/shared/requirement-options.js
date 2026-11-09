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

const inputLabels = { supplementDirectory: '补充文档', developerDirectory: '开发反馈' };

export function requirementOptions(content) {
  const text = String(content ?? '');
  const fields = [
    ['projectFolderUrl', '用例存放|用例目录'],
    ['reportDirectory', '输出路径|结果路径'],
    ...Object.entries(inputLabels),
  ];
  const options = {};
  for (const [key, label] of fields) {
    const values = new Set([...text.matchAll(new RegExp('^\\s*(?:' + label + ')\\s*[:：]([^\\r\\n]*)', 'gm'))]
      .map(match => match[1].trim()));
    if (values.size > 1 || values.has('')) throw new Error('请为「' + label.replace('|', '／') + '」填写一个明确值。');
    if (values.size) options[key] = [...values][0];
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
  return resolved;
}

function approvedDirectory(value, allowed, label) {
  const key = directoryKey(value);
  const directory = key && allowed.find(candidate => directoryKey(candidate) === key);
  if (!directory) throw new Error(label + '未登记为本项目的绝对路径。');
  return path.normalize(directory);
}
