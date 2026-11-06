import { observationAt, evaluateCaseAssertion, evaluateDerivedAssertion, validateDerivedTerms } from './requirement-assertions.js';
import { agentError } from './requirement-agent-resources.js';

export function assertionBinding(check, observation, args, sources, context = {}) {
  const refs = args.sourceRefs ?? check.measurement?.sourceRefs;
  if (args.calculation && (!Array.isArray(args.calculation.terms)
    || args.calculation.terms.some(term => !term || typeof term !== 'object'))) {
    throw agentError('calculation.terms must be an array of {field:[actual value path],sign:1|-1}');
  }
  const fields = args.calculation ? args.calculation.terms.map(term => term.field) : [args.field];
  if (!Array.isArray(fields) || !fields.length || fields.some(field => !Array.isArray(field) || !field.length)) {
    throw agentError('Use field:[actual value path] or calculation:{terms:[{field,sign:1|-1}]}');
  }
  if (args.calculation && (args.field || check.type !== 'number'
    || args.calculation.terms.some(term => ![1, -1].includes(term.sign)))) {
    throw agentError('A numeric calculation uses signed observed operands, without a separate field');
  }
  if (args.calculation) {
    try { validateDerivedTerms(args.calculation.terms); } catch (error) { throw agentError(error.message); }
    if (args.calculation.terms.some(term => term.nullAs) && !refs?.length) {
      throw agentError('nullAs requires sourceRefs proving the field business meaning and the explicit null conversion');
    }
    if (args.calculation.terms.some(term => term.nullAs) && observation.channel === 'api'
      && (!(observation.data.status >= 200 && observation.data.status < 300) || observation.data.body?.success === false
        || observation.data.body?.ok === false || observation.data.body?.error)) {
      throw agentError('nullAs cannot reinterpret a failed HTTP response as a numeric business result');
    }
  }
  if (check.channel === 'page' && (fields.some(field => field[0] !== 'values')
    || args.identity?.some(identity => identity.field?.[0] !== 'values'))) {
    throw agentError('Page assertions and subject identities must use observed DOM values; captured API traffic is diagnostic evidence only');
  }
  const selected = fields.map(field => ({ field,
    ...(check.channel === 'page' ? { measurement: observation.data.measurements?.[field[1]] ?? observation.input?.fields?.[field[1]] } : {}),
    valueType: observationAt(observation.data, field) === null ? 'null' : Array.isArray(observationAt(observation.data, field)) ? 'array'
      : typeof observationAt(observation.data, field) }));
  if (refs && (!Array.isArray(refs) || refs.some(ref => !sources[ref]?.text))) throw agentError('sourceRefs must reference concrete source already read by this Job');
  const tokens = fields.flat().filter(part => typeof part === 'string' && !['body', 'data', 'rows', 'values'].includes(part));
  const evidence = refs ? refs.map(ref => ({ sourceRef: ref, ...sources[ref] }))
    : check.channel === 'api' ? Object.entries(sources).filter(([, source]) => source.text && tokens.some(token => source.text.includes(token)))
      .map(([sourceRef, source]) => ({ sourceRef, ...source })) : [];
  const query = observation.measurement ?? (observation.input?.sql ? observation.input : undefined);
  const databaseSchemas = query?.sql ? Object.values(context.schemas ?? {}).filter(schema => schema.resource === query.resource
    && schema.database === query.database && /^[A-Za-z0-9_]+$/.test(schema.table)
    && new RegExp('\\b' + schema.table + '\\b', 'i').test(query.sql)) : undefined;
  return { requirement: check.requirement, channel: check.channel, type: check.type, unit: check.unit,
    subject: check.subject, selected, calculation: args.calculation,
    verifiedIdentity: context.verifiedIdentity, planContext: context.planContext, supportingEvidence: context.supportingEvidence,
    request: observation.channel === 'api' ? { path: observation.data.path, method: observation.data.method, status: observation.data.status, request: observation.data.request } : undefined,
    responseOutcome: observation.channel === 'api' && observation.data.body && !Array.isArray(observation.data.body)
      ? Object.fromEntries(Object.entries(observation.data.body).filter(([key]) => /^(?:success|ok|code|error|errorCode|message)$/.test(key))) : undefined,
    query, databaseSchemas,
    page: check.channel === 'page' ? { url: observation.data.url, ready: observation.data.ready, dom: observation.data.dom } : undefined,
    sources: evidence };
}

export function compareAgentObservation(check, observation, args) {
  const rule = { ...check, assertion: check.id, field: args.field, fragment: check.requirement,
    encoding: check.type === 'number' ? 'decimal-text' : undefined };
  if (args.calculation) return evaluateDerivedAssertion(observation.data, rule, args.calculation.terms);
  if (check.type === 'null' && check.channel === 'api' && (!(observation.data.status >= 200 && observation.data.status < 300)
    || observation.data.body?.success === false || observation.data.body?.ok === false || observation.data.body?.error)) {
    return { assertion: check.id, expected: null, compared: false, passed: false, reason: 'Failed response does not prove a business null' };
  }
  const value = observationAt(observation.data, args.field);
  const descriptor = observation.data.measurements?.[args.field?.[1]];
  const missingPageField = check.channel === 'page' && descriptor?.matches === 0
    && !['count', 'visible'].includes(descriptor.read);
  const missingApiField = check.channel === 'api' && !(observation.data.status >= 400) && (value === undefined || value === null && check.type !== 'null');
  if (missingPageField || missingApiField) return { assertion: check.id, fragment: check.requirement, field: args.field,
    expected: check.expected, expectedUnit: check.unit, observed: null, missing: true, compared: true, passed: false,
    reason: missingPageField ? 'The expected field is absent from the business-ready page' : 'The verified response field has no value' };
  return evaluateCaseAssertion(observation.data, rule);
}
