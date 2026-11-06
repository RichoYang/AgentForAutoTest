// The advertised schema and host validation share one definition. Business
// payloads remain open maps; executable tool structure is explicit and checked.
const string = { type: 'string', minLength: 1 }, integer = { type: 'integer', minimum: 0 };
const object = (properties, required = [], extra = false) => ({ type: 'object', properties, required, additionalProperties: extra });
const array = (items, minItems = 0) => ({ type: 'array', items, minItems });
const map = { type: 'object', additionalProperties: true };
const enumeration = (...values) => ({ enum: values });
const field = array({ anyOf: [string, integer] }, 1);
const page = { offset: integer, limit: { type: 'integer', minimum: 1 } };
const conditions = array(object({ field, operator: enumeration('equals', 'absent', 'contains'), expected: {} }, ['field', 'operator']), 1);
const identity = array(object({ dimension: string, field }, ['dimension', 'field']));
const evidenceRefs = array(object({ observationId: string, fields: array(field, 1) }, ['observationId', 'fields']));
const calculation = object({ terms: array(object({ field, sign: enumeration(1, -1), nullAs: object({
  value: { anyOf: [{ type: 'number' }, string] }, reason: string }, ['value', 'reason']) }, ['field', 'sign']), 1) }, ['terms']);
const selection = { observationId: string, field, identity, calculation, sourceRefs: array(string, 1), evidenceRefs,
  snapshot: { type: 'boolean' }, constraints: array(object({ observationId: string, field,
    operator: enumeration('equals', 'gt', 'gte', 'lt', 'lte'), expected: {} }, ['observationId', 'field', 'operator', 'expected'])) };
const pathTemplate = string; // Dynamic segments use /resource/{inputName}, never a whole unvalidated route.
const spec = object({ resource: string, kind: enumeration('http', 'database', 'browser'), access: enumeration('read', 'create', 'update', 'delete', 'trigger'),
  path: pathTemplate, method: string, body: {}, query: map, authenticated: { type: 'boolean' }, channel: enumeration('api', 'message', 'job'),
  database: string, sql: string, params: array({}), table: string, values: map, where: map, expectedRows: { type: 'integer', minimum: 1 },
  action: enumeration('click', 'goto'), selector: string, effect: object({ path: pathTemplate, method: string, body: {} }, ['path', 'method']) }, ['resource', 'kind', 'access']);
const measurement = object(selection, ['observationId']);
const check = object({ id: string, line: { type: 'integer', minimum: 1 }, requirement: string,
  channel: enumeration('page', 'api', 'database', 'message', 'job'), subject: map, expected: {},
  operator: enumeration('equals', 'contains', 'gt', 'gte', 'lt', 'lte'), type: enumeration('number', 'text', 'boolean', 'null'), unit: { type: 'string' },
  basis: object({ quote: string, observationId: string, field, explanation: string }), measurement },
['id', 'line', 'requirement', 'channel', 'expected', 'operator', 'type', 'basis']);
const processCheck = object({ id: string, line: { type: 'integer', minimum: 1 }, requirement: string,
  kind: enumeration('execution_evidence', 'receipt_reconciliation', 'readiness', 'cleanup'), relatedCheckIds: array(string) }, ['id', 'line', 'requirement', 'kind']);
const invocation = { operation: string, input: map, subject: map, ...page };
const readiness = object({ field, operator: enumeration('equals', 'not_equals'), value: {},
  timeoutMs: { type: 'integer', minimum: 1 } }, ['field', 'operator', 'value']);
const mutation = object({ ...invocation, id: string, purpose: enumeration('prepare', 'scenario'), businessKey: string,
  ownership: object({ field, value: {} }, ['field', 'value']), verify: object({ operation: string, input: map, stateFields: array(field, 1), before: conditions, after: conditions, ready: readiness }, ['operation', 'before', 'after']),
  restore: object({ operation: string, input: map }, ['operation']), cleanupAction: string, shared: { type: 'boolean' } },
['id', 'purpose', 'operation', 'businessKey', 'ownership', 'verify', 'restore', 'cleanupAction']);
export const requirementToolSchemas = {
  source: object({ action: enumeration('files', 'search', 'read', 'refs', 'history', 'show'), path: { type: 'string' }, pattern: string,
    start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 }, ref: string, file: string, ...page }, ['action']),
  schema: object({ resource: string, database: string, table: string }, ['resource']),
  read_sql: object({ resource: string, database: string, sql: string, params: array({}), subject: map, ...page }, ['resource', 'database', 'sql']),
  snapshot: object({ resource: string, database: string, table: string, scope: map, fields: array(string, 1), pageSize: { type: 'integer', minimum: 1 }, ...page }, ['resource', 'database', 'table', 'scope']),
  register: object({ name: string, sourceRefs: array(string, 1), reason: string, spec }, ['name', 'sourceRefs', 'reason', 'spec']),
  observe: object(invocation, ['operation']),
  evidence: { anyOf: [object({ observationId: string, field, ...page }, ['observationId']),
    object({ evidenceRef: string, field, ...page }, ['evidenceRef'])] },
  alias: object({ alias: string, value: {}, observationId: string, field, purpose: string }, ['alias', 'value', 'observationId', 'field', 'purpose']),
  mutate: mutation,
  browser: object({ resource: string, action: enumeration('goto', 'inspect', 'fill', 'click', 'select', 'check', 'wait', 'observe', 'fault', 'clear_fault'),
    path: string, selector: string, value: {}, subject: map, ready: object({ selector: string, state: enumeration('hidden', 'visible'), attribute: string, value: {}, text: string }, ['selector']),
    fields: { type: 'object', additionalProperties: object({ selector: string, read: enumeration('text', 'input', 'visible', 'count', 'attribute'), attribute: string }, ['selector', 'read']) },
    operation: string, delayMs: { type: 'number', minimum: 0 }, abort: { type: 'boolean' }, status: { type: 'integer' }, body: {} }, ['resource', 'action']),
  plan: { anyOf: [object({ action: { const: 'inspect' } }, ['action']),
    object({ identityCorrections: array(object({ checkId: string, subject: map }, ['checkId', 'subject']), 1) }, ['identityCorrections']),
    object({ version: { const: 1 }, steps: array(string, 1), prerequisites: array(object({ objects: string, target_state: string, construction_entry: string,
      unique_identifier: string, verification_method: string, cleanup_method: string }, ['objects', 'target_state', 'construction_entry', 'unique_identifier', 'verification_method', 'cleanup_method'])), checks: array(check, 1), processChecks: array(processCheck) }, ['version', 'steps', 'prerequisites', 'checks'])] },
  measure: { anyOf: [object({ action: { const: 'restart' }, reason: string }, ['action', 'reason']),
    object({ checkId: string, ...selection }, ['checkId', 'observationId'])] },
  assert: object({ checkId: string, ...selection }, ['checkId', 'observationId']),
  process: object({ checkId: string, evidenceRefs, sourceRefs: array(string, 1) }, ['checkId', 'evidenceRefs']),
  finish: object({ actual: string, blocker: object({ dependency: string, required_action: string, attempts: array(string, 1) }, ['dependency', 'required_action', 'attempts']),
    classification: enumeration('产品', '配置', '部署', '数据', '外部依赖'), reason: string }, ['actual']),
  concurrent: object({ actions: array({ anyOf: [object({ tool: { const: 'mutate' }, args: mutation }, ['tool', 'args']),
    object({ tool: { const: 'observe' }, args: object(invocation, ['operation']) }, ['tool', 'args'])] }, 1) }, ['actions']),
  cleanup: object({}),
};

export function schemaErrors(schema, value, at = '$.args') {
  if (schema.anyOf) {
    const variants = schema.anyOf.map(item => schemaErrors(item, value, at));
    return variants.some(errors => !errors.length) ? [] : variants.sort((a, b) => a.length - b.length)[0];
  }
  const errors = [];
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(at + ' must equal ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.includes(value)) errors.push(at + ' must be one of ' + schema.enum.join(', '));
  const type = schema.type;
  const valid = !type || type === 'object' ? !type || value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type && (type !== 'number' || Number.isFinite(value));
  if (!valid) return [...errors, at + ' must be ' + type];
  if (typeof value === 'string' && value.length < (schema.minLength ?? 0)) errors.push(at + ' must be nonempty');
  if (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) errors.push(at + ' must be >= ' + schema.minimum);
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0)) errors.push(at + ' has too few items');
    value.forEach((item, i) => errors.push(...schemaErrors(schema.items ?? {}, item, `${at}[${i}]`)));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(at + '.' + key + ' is required');
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaErrors(schema.properties[key], item, at + '.' + key));
      else if (schema.additionalProperties === false) errors.push(at + '.' + key + ' is not supported');
      else if (typeof schema.additionalProperties === 'object') errors.push(...schemaErrors(schema.additionalProperties, item, at + '.' + key));
    }
  }
  return errors;
}

export function validateToolArguments(name, args) {
  const errors = requirementToolSchemas[name] ? schemaErrors(requirementToolSchemas[name], args) : ['Unknown test tool: ' + name];
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'tool_contract', safeMessage: errors.join('; '), fields: errors });
}
