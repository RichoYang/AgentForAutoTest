import { digest } from './requirement-feishu.js';

export function observationAt(value, keys = []) {
  return keys.reduce((item, key) => item != null && Object.hasOwn(Object(item), key) ? item[key] : undefined, value);
}

const operators = Object.entries({
  大于等于: 'gte', 小于等于: 'lte', 不少于: 'gte', 不超过: 'lte', 至少: 'gte', 至多: 'lte',
  大于: 'gt', 高于: 'gt', 超过: 'gt', 小于: 'lt', 低于: 'lt', 等于: 'equals', 包含: 'contains',
  显示: 'equals', 为: 'equals', 是: 'equals', '>=': 'gte', '<=': 'lte',
  '≥': 'gte', '≤': 'lte', '>': 'gt', '<': 'lt', '=': 'equals', ':': 'equals',
}).sort((a, b) => b[0].length - a[0].length);

function observations(operations) {
  const meanings = new Map();
  for (const spec of Object.values(operations)) {
    for (const contract of spec.observations ?? []) {
      if (!contract.id || !Array.isArray(contract.field) || !contract.field.length
        || ['status', 'success', 'errorCode'].includes(contract.field[0])) continue;
      const { id, label, aliases, type, unit, previous } = contract;
      const meaning = { id, label, aliases, type, unit, previous };
      if (!meanings.has(id)) meanings.set(id, meaning);
      else if (digest(meanings.get(id)) !== digest(meaning)) meanings.set(id, null);
    }
  }
  return [...meanings.values()].filter(Boolean);
}

function splitConditions(text) {
  // Keep quoted business values intact. Unrecognized fragments remain explicit gaps.
  const separators = /^(?:[,;。]|并且|同时|且|以及|但是|但(?=不)|并(?=不|无|未|保留|显示))/;
  const pieces = [];
  let start = 0;
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quote) { if (ch === quote) quote = ''; continue; }
    quote = ({ '"': '"', '“': '”', '「': '」', '『': '』' })[ch] ?? '';
    if (quote) continue;
    const separator = text.slice(index).match(separators);
    if (!separator) continue;
    const piece = text.slice(start, index).trim();
    if (piece) pieces.push(piece);
    index += separator[0].length - 1;
    start = index + 1;
  }
  if (text.slice(start).trim()) pieces.push(text.slice(start).trim());
  return pieces;
}

function parsePredicate(text, vocabulary) {
  const original = text.trim();
  const clean = vocabulary.some(([label]) => original.startsWith(label)) ? original
    : original.replace(/^(?:(?:(?:在)?页面(?:上)?|界面(?:上)?|系统|应当|应|显示|展示|可以看到|可见|的)\s*)+/, '').trim();
  const exclude = clean.match(/^(?:不包含|不含|未包含|排除|不计入)\s*/)?.[0];
  const leftText = exclude ? clean.slice(exclude.length) : clean;
  const matches = vocabulary.filter(([label]) => leftText.startsWith(label));
  const longest = matches[0]?.[0].length;
  const candidates = matches.filter(([label]) => label.length === longest);
  if (new Set(candidates.map(([, item]) => item.id)).size !== 1) return null;
  const [label, left] = candidates[0];
  const tail = leftText.slice(label.length).trim().replace(/^(?:应当|应)\s*/, '');
  if (left.type === 'text' && left.previous) {
    const transition = tail.match(/^从([^,;。]+?)(?:变为|变成|转为|到)([^,;。]+)$/);
    const previous = vocabulary.find(([, item]) => item.id === left.previous && item.type === 'text');
    if (transition && previous) return [
      { observation: left.previous, operator: 'equals', expected: transition[1].trim() },
      { observation: left.id, operator: 'equals', expected: transition[2].trim() },
    ];
  }
  if (left.type === 'boolean' && (exclude && !tail || /^(?:存在|不存在|为真|为假)$/.test(tail))) {
    return { observation: left.id, operator: 'equals', expected: !exclude && ['存在', '为真'].includes(tail) };
  }
  const match = operators.find(([word]) => tail.startsWith(word));
  const operator = match?.[1] ?? 'equals';
  const right = (match ? tail.slice(match[0].length) : tail).trim();
  if (left.type === 'number' && operator !== 'contains') {
    const literal = right.match(/^(-?\d+(?:\.\d+)?)\s*(\S*)$/);
    if (literal && literal[2] === (left.unit ?? '') && Number.isFinite(Number(literal[1]))) {
      return { observation: left.id, operator, expected: Number(literal[1]), decimal: literal[1] };
    }
    const terms = right.split(/\s*([+\-−加减])\s*/);
    const operands = terms.filter((_, index) => index % 2 === 0).map(term => {
      const hits = vocabulary.filter(([label, item]) => term === label && item.type === 'number' && item.unit === left.unit);
      const ids = [...new Set(hits.map(([, item]) => item.id))];
      return ids.length === 1 ? ids[0] : null;
    });
    if (operands.length && operands.every(id => id && id !== left.id)) {
      return { observation: left.id, operator, expression: operands.map((id, index) => ({
        id, sign: index && ['-', '−', '减'].includes(terms[index * 2 - 1]) ? -1 : 1,
      })) };
    }
  }
  if (left.type === 'text' && match && ['equals', 'contains'].includes(operator)) {
    const quoted = right.match(/^(?:「([^」]+)」|“([^”]+)”|"([^"]+)")$/);
    if (quoted || /^[^,。;?!:]+$/.test(right) && !/(?:由于|之后|之前|否则|若|如果|时[,，]|不覆盖)/.test(right)) {
      return { observation: left.id, operator, expected: quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : right };
    }
  }
  return null;
}

export function compileCaseAssertions(expectedText, operations) {
  const original = String(expectedText ?? '');
  const vocabulary = observations(operations).flatMap(item => [item.label, ...(item.aliases ?? [])]
    .filter(Boolean).map(label => [label.normalize('NFKC'), item])).sort((a, b) => b[0].length - a[0].length);
  const clauses = original.split(/\r?\n/).filter(line => line.trim()).flatMap((line, index) =>
    splitConditions(line.replace(/^\s*\d+[.、）)]\s*/, '').normalize('NFKC')).map(fragment => ({ line: index + 1, fragment })));
  return { original, clauses: clauses.flatMap(({ line, fragment }) =>
    [parsePredicate(fragment, vocabulary)].flat().map(predicate => ({ line, fragment, predicate })))
    .map((clause, index) => ({ assertion: index + 1, ...clause })) };
}

export function bindCaseAssertions(expectedText, steps, operations, compiled = compileCaseAssertions(expectedText, operations)) {
  const claimed = new Set();
  const bound = steps.map(step => {
    const spec = operations[step.operation];
    const checks = step.checks.flatMap(check => {
      const source = compiled.clauses[check.assertion - 1];
      const goal = source?.predicate;
      const contract = spec.observations?.find(item => item.id === goal?.observation && digest(item.field) === digest(check.field));
      if (!goal || !contract || (check.operator !== undefined && check.operator !== goal.operator)
        || (Object.hasOwn(check, 'expected') && check.expected !== goal.expected)) return [];
      const operands = goal.expression?.map(term => ({ ...term, binding: spec.observations.find(item => item.id === term.id) }));
      if (operands?.some(term => !term.binding)) return [];
      claimed.add(source.assertion);
      return [{ ...goal, ...source, field: contract.field, unit: contract.unit, type: contract.type,
        unitField: contract.unitField, encoding: contract.encoding, operands }];
    });
    return { ...step, checks };
  });
  const missing = compiled.clauses.flatMap(({ assertion, fragment, predicate }) => claimed.has(assertion) ? []
    : ['预期 ' + assertion + (predicate ? ' 未绑定到已登记的观测或运算输入：' : ' 当前无法转换为可核验条件：') + fragment]);
  if (!compiled.clauses.length) missing.push('缺少可验证的业务预期。');
  return { steps: bound, missing, expectedCount: compiled.clauses.length };
}

function observedValue(data, rule) {
  let value = observationAt(data, rule.field);
  const exact = rule.type === 'number' && (typeof value === 'number' && Number.isFinite(value)
    || rule.encoding === 'decimal-text' && typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) ? String(value) : undefined;
  if (rule.type === 'number' && rule.encoding === 'decimal-text' && typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  const unit = rule.unitField ? observationAt(data, rule.unitField) : rule.unit;
  const comparable = (rule.type === 'number' ? Number.isFinite(value) : typeof value === (rule.type === 'text' ? 'string' : rule.type))
    && (!rule.unitField || typeof unit === 'string');
  return { value, unit, comparable, exact };
}

function compareDecimal(left, right) {
  const decimals = [left, ...right.map(item => item.exact)].map(value => {
    const [, integer, fraction = '', exponent = '0'] = value.match(/^(-?\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    return { coefficient: BigInt(integer + fraction), scale: fraction.length - Number(exponent) };
  });
  const scale = Math.max(0, ...decimals.map(item => item.scale));
  const [actual, ...values] = decimals.map(item => item.coefficient * 10n ** BigInt(scale - item.scale));
  const expected = values.reduce((sum, value, index) => sum + value * BigInt(right[index].sign), 0n);
  const digits = (expected < 0n ? -expected : expected).toString().padStart(scale + 1, '0');
  const exact = (expected < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
  return { relation: actual < expected ? -1 : actual > expected ? 1 : 0, exact };
}

export function evaluateCaseAssertion(data, rule) {
  const { value, unit, exact, comparable: hasValue } = observedValue(data, rule);
  const inputs = rule.operands?.map(term => ({ id: term.id, sign: term.sign, ...observedValue(data, term.binding) }));
  const operandsValid = !inputs || inputs.every(item => item.comparable && item.unit === rule.unit);
  const numeric = rule.type === 'number';
  const comparison = numeric && hasValue && operandsValid
    ? compareDecimal(exact, inputs ?? [{ exact: rule.decimal ?? String(rule.expected), sign: 1 }]) : null;
  const expected = inputs && comparison ? Number(comparison.exact) : rule.expected;
  const comparable = hasValue && operandsValid && (!numeric || Boolean(comparison));
  const compare = {
    equals: () => numeric ? comparison.relation === 0 : value === expected, contains: () => value.includes(expected),
    gte: () => comparison.relation >= 0, lte: () => comparison.relation <= 0, gt: () => comparison.relation > 0, lt: () => comparison.relation < 0,
  };
  return { assertion: rule.assertion, fragment: rule.fragment, field: rule.field, expected, expectedUnit: rule.unit,
    observed: value, unit, ...(comparison ? { exactExpected: comparison.exact, exactObserved: exact } : {}),
    ...(inputs ? { inputs } : {}), compared: comparable,
    passed: comparable && unit === rule.unit && compare[rule.operator]() };
}
