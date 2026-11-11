import { isDeepStrictEqual } from 'node:util';
import { agentError } from './requirement-agent-resources.js';

const orderedFields = fields => Object.entries(fields ?? {}).sort(([left], [right]) => left.localeCompare(right));
const routeKey = ({ method, path, query, queryInput, exactQuery }) =>
  JSON.stringify([method, path, orderedFields(query), orderedFields(queryInput), exactQuery === true]);

function hasParameterProof(expected, entry) {
  return (!expected.exactQuery || Number.isInteger(entry.unrecordedQuery) && entry.unrecordedQuery === 0)
    && [ ['query', expected.query], ['queryInput', expected.queryInput] ].every(([property, fields]) =>
      Object.entries(fields ?? {}).every(([name, value]) => entry[property] && Object.hasOwn(entry[property], name)
        && isDeepStrictEqual(entry[property][name], value)));
}

export function validateRequestProof(check, scope) {
  const proof = check.requestProof;
  if (!proof) return;
  if (check.kind !== 'execution_evidence' || !scope.resourceNames.includes(proof.resource)) {
    throw agentError('Request proof needs an execution_evidence check and a scoped resource: ' + check.id);
  }
  if (proof.requests.some(item => !/^[A-Z]+$/.test(item.method) || !/^\/(?!\/)[^?#{}\\\s]*$/.test(item.path))
    || new Set(proof.requests.map(routeKey)).size !== proof.requests.length) {
    throw agentError('Request proof needs unique uppercase methods and exact URL pathnames: ' + check.id);
  }
  if (proof.scope === 'service' && (!proof.audit || !scope.runPrefix || !proof.audit.correlation.includes(scope.runPrefix))) {
    throw agentError('Independent request proof needs an audit operation and a task-owned correlation key: ' + check.id);
  }
  if (proof.scope === 'runner' && proof.audit) throw agentError('Runner request proof does not take an independent audit operation: ' + check.id);
  if (proof.scope === 'service' && !proof.audit.matchRunner && proof.requests.some(route => route.queryInput)) {
    throw agentError('Typed inputs require Runner attribution and cannot be inferred from a service audit');
  }
}

export function auditWindow(response, request, checkId, source, fields = []) {
  const report = response.body;
  const at = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const from = at(request.from), through = at(request.through);
  const error = message => Object.assign(agentError('Request proof ' + checkId + ': ' + message),
    { code: 'request_proof_missing', fields: ['$.requestProof.audit'] });
  if (response.status < 200 || response.status >= 300 || !report?.source || typeof report.source !== 'string') {
    throw error('the registered read-only service audit did not return a successful source receipt');
  }
  if (report.correlation !== request.correlation || source && report.source !== source) {
    throw error('the audit source or correlation does not match the preflight and task-owned key');
  }
  if (report.complete !== true || !(at(report.from) <= from && at(report.through) >= through) || !Array.isArray(report.entries)) {
    throw error('the audit receipt must certify complete coverage of the requested window');
  }
  if (report.entries.some(entry => !entry || entry.correlation !== request.correlation || !Number.isFinite(at(entry.at))
    || typeof entry.id !== 'string' || !entry.id || typeof entry.method !== 'string' || typeof entry.path !== 'string')
    || new Set(report.entries.map(entry => entry.id)).size !== report.entries.length) {
    throw error('the audit entries have missing identities, duplicates, or a different correlation');
  }
  return { source: report.source, correlation: report.correlation, from: report.from, through: report.through, complete: true,
    entries: report.entries.filter(entry => at(entry.at) >= from && at(entry.at) <= through)
      .map(entry => {
        const { id, at, method, path, requestId, query, unrecordedQuery } = entry;
        const names = typeof fields === 'function' ? fields(entry) : fields;
        return { id, at, method, path, ...(typeof requestId === 'string' ? { requestId } : {}),
          ...(query && typeof query === 'object' && names.length ? { query: Object.fromEntries(names.filter(name =>
            Object.hasOwn(query, name) && Array.isArray(query[name]) && query[name].every(value => typeof value === 'string'))
            .map(name => [name, query[name]])) } : {}),
          ...(Number.isSafeInteger(unrecordedQuery) && unrecordedQuery >= 0 ? { unrecordedQuery } : {}),
        };
      }) };
}

export function correlateRequestAudit(runnerEntries, auditEntries) {
  const runner = new Map(runnerEntries.map(entry => [entry.id, entry]));
  const seen = new Set();
  const matches = auditEntries.map(entry => {
    const actual = runner.get(entry.requestId);
    if (!actual || seen.has(entry.requestId) || !actual.correlationSent || actual.method !== entry.method
      || actual.path !== entry.path || !isDeepStrictEqual(actual.query, entry.query)
      || actual.unrecordedQuery !== entry.unrecordedQuery) {
      throw Object.assign(agentError('Independent audit contains a duplicate, foreign, or contradictory request receipt'),
        { code: 'request_proof_attribution' });
    }
    seen.add(entry.requestId);
    return { auditId: entry.id, requestId: actual.id, observationIds: actual.observationIds ?? [],
      phase: actual.phase, caseKey: actual.caseKey, epoch: actual.epoch, outcome: actual.outcome };
  });
  if (seen.size !== runner.size) {
    throw Object.assign(agentError('Independent audit is missing a receipt for a Runner request'), { code: 'request_proof_missing' });
  }
  return matches;
}

export function compareRequestProof(check, entries) {
  const matches = check.requestProof.requests.map(contract => {
    const { method, path, count } = contract;
    const attempts = entries.filter(entry => entry.method === method && entry.path === path && hasParameterProof(contract, entry));
    return { method, path, expected: count, actual: attempts.length, attempts };
  });
  if (entries.some(entry => entry.outcome === 'pending'
    && check.requestProof.requests.some(route => route.method === entry.method && route.path === entry.path))) {
    throw Object.assign(agentError('Request proof ' + check.id + ': a transport attempt has no durable disposition after interruption'),
      { code: 'request_proof_missing', fields: ['$.requestProof.requests'] });
  }
  return { scope: check.requestProof.scope, phase: check.requestProof.phase, resource: check.requestProof.resource,
    matches, satisfied: matches.every(item => item.actual === item.expected) };
}

export function verifyRunnerScope(check, entries) {
  const { phase, allowed } = check.runnerScope;
  if (!Array.isArray(entries)) throw agentError('No complete Runner trace for this measurement epoch');
  const inScope = entries.filter(entry => phase === 'all' || phase === entry.phase);
  if (inScope.some(entry => entry.outcome === 'pending')) throw agentError('Runner scope has an unresolved transport attempt');
  const violations = inScope.filter(entry => !allowed.some(route => ['resource', 'transport', 'method', 'path']
    .every(key => route[key] === entry[key]) && hasParameterProof(route, entry)));
  return { phase, allowed, entries: inScope, violations, satisfied: !violations.length };
}

export function runnerScopeHistory(current) {
  const epochs = [...(current.restarts ?? []), current];
  if (epochs.some(epoch => ![2, 3].includes(epoch.requestTraceVersion) || !Array.isArray(epoch.requestTrace))) return null;
  return epochs.flatMap(epoch => epoch.requestTrace);
}

export function externalCleanupReceipt(response, contract, input, source) {
  const body = response?.body;
  if (!(response?.status >= 200 && response.status < 300) || typeof body?.source !== 'string' || !body.source
    || (source && body.source !== source) || body.actor !== contract.actor || body.correlation !== contract.correlation) {
    throw agentError('External cleanup receipt source, actor or object differs from the registered contract');
  }
  if (input.mode === 'capability') {
    if (body.available !== true) throw agentError('External cleanup receipt source did not certify lookup capability');
  } else if (body.verified !== true || !Number.isFinite(Date.parse(input.after))
    || !(Date.parse(body.completedAt) >= Date.parse(input.after) && Date.parse(body.completedAt) <= Date.now())) {
    throw agentError('External cleanup has no verified receipt after the declared boundary');
  }
  const binding = input.jobId ? { jobId: input.jobId, caseId: input.caseId, attempt: input.attempt, epoch: input.epoch } : null;
  if (binding && (Object.entries(binding).some(([field, value]) => !isDeepStrictEqual(body[field], value))
    || input.mode !== 'capability' && (typeof body.receiptId !== 'string' || !body.receiptId))) {
    throw agentError('External cleanup receipt must identify this Job, case, attempt and measurement epoch');
  }
  return { source: body.source, actor: body.actor, correlation: body.correlation, ...binding,
    ...(input.mode === 'capability' ? { available: true } : { completedAt: body.completedAt, verified: true,
      ...(binding ? { receiptId: body.receiptId } : {}) }) };
}
