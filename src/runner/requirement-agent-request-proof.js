import { agentError } from './requirement-agent-resources.js';

const routeKey = ({ method, path }) => method + ' ' + path;

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
}

export function auditWindow(response, request, checkId, source) {
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
      .map(({ id, at, method, path }) => ({ id, at, method, path })) };
}

export function compareRequestProof(check, entries) {
  const matches = check.requestProof.requests.map(({ method, path, count }) => {
    const attempts = entries.filter(entry => entry.method === method && entry.path === path);
    return { method, path, expected: count, actual: attempts.length, attempts };
  });
  if (matches.some(item => item.attempts.some(attempt => attempt.outcome === 'pending'))) {
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
    .every(key => route[key] === entry[key])));
  return { phase, allowed, entries: inScope, violations, satisfied: !violations.length };
}

export function runnerScopeHistory(current) {
  const epochs = [...(current.restarts ?? []), current];
  if (epochs.some(epoch => epoch.requestTraceVersion !== 2 || !Array.isArray(epoch.requestTrace))) return null;
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
  return { source: body.source, actor: body.actor, correlation: body.correlation,
    ...(input.mode === 'capability' ? { available: true } : { completedAt: body.completedAt, verified: true }) };
}
