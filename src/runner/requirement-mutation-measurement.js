import { digest } from './requirement-feishu.js';
import { agentError } from './requirement-agent-resources.js';

function selected(value, field) {
  let current = value;
  for (const [index, segment] of field.entries()) {
    if (current === null) return { nullAncestor: field.slice(0, index) };
    if (Array.isArray(current) && !current.length && typeof segment === 'number') return { emptyCollection: field.slice(0, index) };
    if (current === undefined || !Object.hasOwn(Object(current), segment)) throw agentError('Readback field is absent: ' + JSON.stringify(field));
    current = current[segment];
  }
  return { value: current };
}

export function mutationReadbackHash(value, fields) {
  return digest(fields?.length ? fields.map(field => selected(value, field)) : value);
}

export function validateMutationReadback(intent) {
  // Paths address the connector's response, never the tool's outer data envelope.
  const root = intent.verifySpec.kind === 'http' ? 'body' : intent.verifySpec.kind === 'database' ? 'rows' : null;
  for (const [label, field] of [['ownership', intent.ownership.field],
    ...(intent.stateFields ?? []).map((field, i) => ['stateFields[' + i + ']', field])]) {
    if (root && field[0] !== root) throw agentError(label + '.field must start with ' + root + '; paths are relative to observation.data');
  }
  for (const [label, rules] of [['before', intent.before], ['after', intent.after]]) for (const [i, rule] of rules.entries()) {
    if (!Object.hasOwn(intent.snapshot, rule.field[0])) throw agentError(label + '[' + i + '].field has no response root: ' + JSON.stringify(rule.field));
  }
  mutationReadbackHash(intent.snapshot, intent.stateFields);
}

// Older journals may contain paths into the HTTP body without the transport
// envelope. Correct ONLY that unambiguous prefix, from the saved raw evidence.
// Caller must independently review it, archive the original and re-read state.
export function repairHttpEnvelope(intent) {
  if (intent.verifySpec.kind !== 'http' || !intent.snapshot?.body || typeof intent.snapshot.body !== 'object') throw agentError('Saved evidence cannot prove HTTP envelope correction');
  const correction = structuredClone(intent);
  const field = original => {
    if (original[0] === 'body') return original;
    if (Object.hasOwn(intent.snapshot, original[0]) || !Object.hasOwn(intent.snapshot.body, original[0])) throw agentError('Saved evidence cannot prove field correction: ' + JSON.stringify(original));
    return ['body', ...original];
  };
  correction.ownership.field = field(correction.ownership.field);
  correction.stateFields = correction.stateFields?.map(field);
  correction.before = correction.before.map(rule => ({ ...rule, field: field(rule.field) }));
  correction.after = correction.after.map(rule => ({ ...rule, field: field(rule.field) }));
  validateMutationReadback(correction);
  return correction;
}

export function verifiedMutationCleanup(mutation) {
  if (mutation.cleanup?.verified !== true) return false;
  if (!mutation.intent?.agent) return true;
  const intent = mutation.cleanup.measurementCorrection?.intent ?? mutation.intent;
  try {
    validateMutationReadback(intent);
    return mutation.cleanup.after !== undefined
      && mutationReadbackHash(mutation.cleanup.after, intent.stateFields) === mutationReadbackHash(intent.snapshot, intent.stateFields);
  } catch { return false; }
}
