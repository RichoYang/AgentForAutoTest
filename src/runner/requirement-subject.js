import { observationAt } from './requirement-assertions.js';

const same = (a, b) => a != null && b != null && ['string', 'number', 'boolean'].includes(typeof a)
  && ['string', 'number', 'boolean'].includes(typeof b) && String(a) === String(b);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function anchoredSources(scope) {
  const anchors = new Set((scope.requirements ?? []).filter(item => scope.item.requirementIds?.includes(item.id)).map(item => item.anchor));
  const xml = scope.source?.xml ?? '';
  const blocks = [];
  for (const match of xml.matchAll(/<([\w-]+)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
    const anchor = match[0].match(/\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/);
    const id = anchor?.[1] ?? anchor?.[2];
    if (!anchors.has(id) || match[0].endsWith('/>')) continue;
    const start = match.index + match[0].length;
    const end = xml.indexOf('</' + match[1] + '>', start);
    if (end >= 0) blocks.push({ origin: id, text: xml.slice(start, end).replace(/<[^>]+>/g, ' ') });
  }
  return [...blocks, ...(scope.source?.supplements ?? []).flatMap(file => (file.sections ?? [])
    .filter(section => anchors.has(section.anchor)).map(section => ({ origin: section.anchor, text: section.text })))];
}

export function caseSubject(scope, dimensions) {
  const cells = Object.fromEntries(scope.headers.map((header, index) => [header, scope.row[index]]));
  const sources = ['前置条件', '操作步骤', '预期结果', '测试数据'].flatMap(header =>
    cells[header] ? [{ origin: header, text: cells[header] }] : []);
  const requirementSources = anchoredSources(scope);
  const values = {};
  const gaps = [];
  for (const [dimension, contract] of Object.entries(dimensions ?? {})) {
    const matches = candidates => candidates.flatMap(({ origin, text }) => (contract.labels ?? []).flatMap(label => {
      const pattern = new RegExp(escape(label) + '\\s*(?:为|是|[:：=])?\\s*["“「]?(' + contract.pattern + ')(?![\\w-])', 'gu');
      return [...text.matchAll(pattern)].map(match => ({ origin, value: match[1], excerpt: match[0] }));
    }));
    const local = matches(sources);
    const anchored = matches(requirementSources);
    const selected = local.length ? local : anchored;
    const distinct = [...new Set(selected.map(item => item.value))];
    if (local.length && anchored.length && distinct.some(value => !anchored.some(item => item.value === value))) {
      gaps.push('用例与原始需求锚点的维度不一致：' + dimension);
    } else if (distinct.length === 1) {
      values[dimension] = { value: distinct[0], sources: [...new Map([...selected, ...anchored.filter(item => item.value === distinct[0])]
        .map(item => [JSON.stringify(item), item])).values()] };
    }
    else if (distinct.length > 1) {
      values[dimension] = { candidates: distinct.map(value => ({ value, sources: selected.filter(item => item.value === value) })) };
    }
    else if (contract.required === true || sources.some(item => contract.labels?.some(label => item.text.includes(label)))) {
      gaps.push('无法独立确定用例维度 ' + dimension);
    }
  }
  return { values, gaps };
}

export function bindSubjectInput({ spec, step, input, expected, lineage, index }) {
  const entries = {};
  const bindings = spec.subject ?? {};
  const required = new Set([...Object.keys(bindings), ...(step.checks.length ? Object.keys(expected) : [])]);
  for (const name of required) {
    const binding = bindings[name];
    const available = expected[name];
    const selected = step.subject?.[name];
    const intended = available?.candidates
      ? available.candidates.find(candidate => same(candidate.value, selected)) : available;
    const value = input[binding?.input];
    const reference = step.input[binding?.input];
    const upstream = reference && typeof reference === 'object' ? lineage[reference.from] : null;
    const proof = upstream?.subject[name];
    const derived = binding?.derived === true;
    const allowedSource = binding?.derivedFrom;
    const traceable = intended && (derived
      ? reference && allowedSource?.operation === upstream?.operation
        && JSON.stringify(allowedSource?.field) === JSON.stringify(reference.field)
        && same(proof?.expected, intended.value) && same(observationAt(upstream?.data, reference.field), value)
      : same(value, intended.value));
    if (!binding || !traceable || (!binding.output && binding.verify !== 'query')) {
      return { error: '步骤 ' + (index + 1) + ' 的测试对象或参数来源无法核验：' + name, name,
        intended, input: binding?.input, actual: value, reference };
    }
    entries[name] = { binding, expected: intended.value, sources: intended.sources, input: value,
      ...(derived ? { upstream: upstream.evidence, reference } : {}) };
  }
  return { entries };
}

export function verifySubjectOutput(data, entries, spec) {
  const verified = {};
  for (const [name, entry] of Object.entries(entries)) {
    const { binding } = entry;
    const query = spec.kind === 'browser' && data?.network?.find(item => item.state === 'response' && item.query === binding.query);
    const actual = binding.output ? observationAt(data, binding.output)
      : spec.kind === 'browser' ? query?.params?.[binding.parameter ?? binding.input] : entry.input;
    const expected = binding.output && binding.derived === true && binding.outputIdentity === 'input' ? entry.input
      : binding.output ? entry.expected : entry.input;
    if (!same(actual, expected)) return { error: '运行观测无法证实测试对象：' + name, name, actual, expected };
    verified[name] = { ...entry, observed: actual };
  }
  return { verified };
}
