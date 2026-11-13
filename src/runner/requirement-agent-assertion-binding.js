import { observationAt, evaluateCaseAssertion, evaluateDerivedAssertion, validateDerivedTerms } from './requirement-assertions.js';
import { agentError } from './requirement-agent-resources.js';
import {isDeepStrictEqual} from 'node:util';

export function verifyObservationIdentity(check,observation,args){
  return Object.entries(check.subject??{}).map(([dimension,value])=>{
    const identity=args.identity?.find(item=>item.dimension===dimension);
    if(!identity||!isDeepStrictEqual(observationAt(observation.data,identity.field),value))throw agentError('Observation identity differs for '+dimension+'; an empty row cannot prove row identity; use verified snapshot scope or actual parent evidence for preflight');
    return {dimension,field:identity.field,value:observationAt(observation.data,identity.field),...(check.channel==='page'?{measurement:observation.data.measurements?.[identity.field?.[1]]}:{})};
  });
}

export function pageMethodSample(check, observation, args, stage) {
  if (!args.sampleSubject) return check;
  const action = observation.data.lifecycle?.pageAction;
  const matchesStage = stage && observation.data.ready?.at && observation.input?.resource === stage.resource
    && action?.action === stage.action && (stage.action === 'goto' ? action.path === stage.path : action.selector === stage.selector)
    && (!Object.hasOwn(stage, 'value') || isDeepStrictEqual(stage.value, action.value))
    && (!stage.ready || isDeepStrictEqual(stage.ready, observation.data.ready?.condition));
  const identityFields = Object.keys(check.subject ?? {});
  const descriptor = observation.data.measurements?.[args.field?.[1]]?.record;
  const differences = identityFields.filter(dimension => !isDeepStrictEqual(check.subject[dimension], args.sampleSubject[dimension]));
  const key = args.identity?.find(item => item.dimension === differences[0])?.field;
  if (check.channel !== 'page' || !matchesStage || check.beforeAction || check.basis?.observationId
    || args.field?.[0] !== 'values' || !descriptor || differences.length !== 1
    || !isDeepStrictEqual(Object.keys(args.sampleSubject).sort(), identityFields.sort())
    || key?.[0] !== 'values' || key?.[1] !== args.field[1] || !Object.hasOwn(descriptor.match, key?.[2])) {
    throw agentError('sampleSubject is only for a method-only DOM record on the declared page stage, with the same scope and a different exact record key. It cannot certify a baseline or a business result.');
  }
  return { ...check, subject: args.sampleSubject, sampleKeyField: key[2] };
}

function domRecordShape(record) {
  return { layout: record.layout, rows: record.rows, fields: record.fields, keyFields: Object.keys(record.match).sort() };
}

export function verifyPageMethodShape(sample, { field, keyField }, observed, args) {
  const before = sample?.data.measurements?.[field[1]]?.record;
  const after = observed.data.measurements?.[args.field?.[1]]?.record;
  const shape = record => {
    const { [keyField]: key, ...scope } = record.match;
    return { ...domRecordShape(record), scope, hasKey: key !== undefined };
  };
  if (!before || !after || !isDeepStrictEqual(field.slice(2), args.field.slice(2)) || !isDeepStrictEqual(shape(before), shape(after))) {
    throw agentError('Actual page record does not use the preflighted record layout, selectors and identity keys');
  }
}

// Stages bind actual saved page actions, never labels added to an observation.
export function pageStageContext(plan,check,current,observations,args={}){
  const stage=plan.pageStages?.find(stage=>stage.id===check.pageStage);if(!stage)return null;
  const stages=plan.pageStages.filter(item=>item.resource===stage.resource),groups=[],byAction=new Map(),boundary=current.scenarioStartedAt??current.planAt;
  const matches=(action,wanted)=>action.action===wanted.action&&(wanted.action==='goto'?action.path===wanted.path:action.selector===wanted.selector)
    &&(!Object.hasOwn(wanted,'value')||isDeepStrictEqual(action.value,wanted.value));
  let legacyAction;
  for(const id of current.observations){const record=observations[id];if(!record||record.channel!=='page'||(record.epoch??0)!==(current.epoch??0)||record.input?.resource!==stage.resource)continue;
    if(['goto','click','select','fill','check'].includes(record.input.action))legacyAction={...record.input,id:record.observationId,startedAt:record.data.lifecycle?.actionStartedAt??record.at};
    const action=record.data.lifecycle?.pageAction??legacyAction;
    if(!action||!boundary||action.startedAt<boundary||!stages.some(stage=>matches(action,stage)))continue;
    let group=byAction.get(action.id);if(!group){group={action,records:[]};byAction.set(action.id,group);groups.push(group);}group.records.push(record);
  }
  const assigned=new Map(),timeline=[];let cursor=0;
  for(const group of groups){let index=stages.findIndex((stage,i)=>i>=cursor&&matches(group.action,stage));
    if(index<0){timeline.push({action:group.action,stageId:null,reason:'additional_visit',observationIds:group.records.map(record=>record.observationId)});continue;}
    const matched=stages[index];assigned.set(matched.id,group);cursor=index+1;timeline.push({action:group.action,stageId:matched.id,observationIds:group.records.map(record=>record.observationId)});
  }
  function actualField(record,identity,sample){
    const descriptor=sample?.data.measurements?.[identity.field?.[1]]??sample?.input?.fields?.[identity.field?.[1]];
    if(!descriptor||identity.field[0]!=='values')return identity.field;
    const same=candidate=>candidate&&(descriptor.record
      ? candidate.record && isDeepStrictEqual(domRecordShape(candidate.record), domRecordShape(descriptor.record))
      : !candidate.record && ['selector','read','attribute'].every(key=>candidate[key]===descriptor[key]));
    if(same(record.data.measurements?.[identity.field[1]]))return identity.field;
    const alias=Object.entries(record.data.measurements??{}).find(([,candidate])=>same(candidate))?.[0];
    return alias?['values',alias,...identity.field.slice(2)]:null;
  }
  const stageEvidence=stages.map(wanted=>{
    const group=assigned.get(wanted.id),related=plan.checks.find(item=>item.pageStage===wanted.id)??check;
    const identities=related.measurement?.identity??[];
    const sample=observations[related.measurement?.observationId];
    const candidates=(group?.records??[]).filter(record=>record.data.screenshot&&record.data.ready?.at>=group.action.startedAt&&record.data.values
      &&(!wanted.ready||isDeepStrictEqual(wanted.ready,record.data.ready.condition))
      &&Object.entries(wanted.subject).every(([dimension,value])=>{const identity=identities.find(item=>item.dimension===dimension),field=identity&&actualField(record,identity,sample);return field&&isDeepStrictEqual(observationAt(record.data,field),value);}));
    return {stageId:wanted.id,action:group?.action,candidateObservationIds:candidates.map(record=>record.observationId),
      observations:candidates.map(record=>({observationId:record.observationId,at:record.at,readyAt:record.data.ready.at})),proven:candidates.length>0};
  });
  const own=stageEvidence.find(item=>item.stageId===stage.id),missingStageIds=stageEvidence.slice(0,stages.indexOf(stage)+1).filter(item=>!item.proven).map(item=>item.stageId);
  const selected=timeline.find(item=>item.observationIds.includes(args.observationId));
  return {stageId:stage.id,step:stage.step,resource:stage.resource,subject:stage.subject,boundary,epoch:current.epoch??0,
    scope:'saved page-action order, identity and readiness; interleaved business-step causality still requires ledger/source review',
    action:own.action,selectedAction:selected?.action,selectedStage:selected?.stageId??(selected?'additional_visit':null),selectedObservationId:args.observationId,
    candidateObservationIds:own.candidateObservationIds,missingStageIds,stages:stageEvidence,relatedCheckIds:plan.checks.filter(item=>item.pageStage===stage.id).map(item=>item.id),timeline,
    valid:!missingStageIds.length&&own.candidateObservationIds.includes(args.observationId)};
}

export function verifyPageStage(plan,check,current,observations,args){
  const proof=pageStageContext(plan,check,current,observations,args);if(!proof||proof.valid)return proof;
  const next=proof.missingStageIds.length?'Missing business-ready identity evidence for historical stages '+proof.missingStageIds.join(', ')+'. Inspect saved page actions/evidence for all affected stages; if it cannot be proved, restore and restart the affected scope. New navigation cannot replace a missing historical stage.'
    :proof.candidateObservationIds.length?'Read the saved current-epoch observations '+proof.candidateObservationIds.join(', ')+' with test_evidence; do not navigate again to recreate a historical stage.'
    :'No business-ready identity-proven observation exists for this historical stage. Inspect saved page actions/evidence; if it cannot be proved, restore and restart the affected scope. New navigation cannot replace the missing first stage.';
  const reason=`Required page stage ${proof.stageId} (step ${proof.step}), selected stage ${proof.selectedStage??'unbound'} (action ${proof.selectedAction?.id??'none'}); missing stages: ${proof.missingStageIds.join(', ')||'none'}; affected checks: ${proof.relatedCheckIds.join(', ')}. ${next}`;
  throw Object.assign(agentError(reason),{code:'page_stage',gapTarget:'page_stage:'+proof.stageId,stageEvidence:proof,
    review:{kind:'assertion_binding',disposition:proof.candidateObservationIds.length?'contradictory_evidence':'missing_evidence',findings:[{field:'plan.pageStages.'+proof.stageId,code:'page_stage',reason,next}]}});
}

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
  if (check.channel === 'page') {
    const records = observation.data.domRecords ?? {};
    for (const field of fields.filter(path => Object.hasOwn(records, path[1]))) {
      const record = records[field[1]];
      const sameRecord = args.identity?.filter(item => item.field[1] === field[1]) ?? [];
      const descriptor = observation.data.measurements[field[1]].record;
      if (record.matched !== 1 || !sameRecord.some(item => Object.hasOwn(check.subject ?? {}, item.dimension)
        && Object.hasOwn(descriptor.match, item.field[2]))
        || args.identity?.some(item => Object.hasOwn(records, item.field[1]) && item.field[1] !== field[1])) {
        throw agentError('DOM record value needs its exact business identity from the same matched DOM record');
      }
    }
  }
  for(const field of fields)if(observation.channel==='database'&&field[0]==='rows'&&Number.isInteger(field[1])&&field.length>=3){
    const names=Array.isArray(observation.data.columns)?observation.data.columns.map(column=>column.name):observation.data.contract?.fields;
    if(names&&!names.includes(field[2]))throw agentError('Measurement field is absent from the verified query/snapshot columns: '+JSON.stringify(field));
  }
  const availability=field=>{let value=observation.data;for(const segment of field){if(value===null)return 'null_ancestor';if(Array.isArray(value)&&!value.length&&typeof segment==='number')return 'empty_collection';if(value===undefined||!Object.hasOwn(Object(value),segment))return 'missing';value=value[segment];}return value===null?'null':'present';};
  const selected = fields.map(field => ({ field,availability:availability(field),
    ...(field[0]==='rows'&&field.length>=3&&observation.data.columns?{queryColumn:observation.data.columns.find(column=>column.name===field[2])}:{}),
    ...(check.channel === 'page' ? { measurement: observation.data.measurements?.[field[1]] ?? observation.input?.fields?.[field[1]] } : {}),
    valueType: observationAt(observation.data, field) === null ? 'null' : Array.isArray(observationAt(observation.data, field)) ? 'array'
      : typeof observationAt(observation.data, field),
    ...(check.type==='number'&&!args.calculation&&/^-?\d+(?:\.\d+)?$/.test(String(observationAt(observation.data,field)))
      ?{representation:{encoding:'decimal-text',exact:typeof observationAt(observation.data,field)==='string'||Number.isFinite(observationAt(observation.data,field))&&(!Number.isInteger(observationAt(observation.data,field))||Number.isSafeInteger(observationAt(observation.data,field)))}}:{}) }));
  if (refs && (!Array.isArray(refs) || refs.some(ref => !sources[ref]?.text))) throw agentError('sourceRefs must reference concrete source already read by this Job');
  const tokens = fields.flat().filter(part => typeof part === 'string' && !['body', 'data', 'rows', 'values'].includes(part));
  const evidenceRefs = refs ?? observation.lifecycle?.operation?.sourceRefs;
  const evidence = evidenceRefs?.length ? evidenceRefs.map(ref => ({ sourceRef: ref, ...sources[ref] }))
    : check.channel === 'api' ? Object.entries(sources).filter(([, source]) => source.text && tokens.some(token => source.text.includes(token)))
      .map(([sourceRef, source]) => ({ sourceRef, ...source })) : [];
  const query = observation.measurement ?? (observation.input?.sql ? observation.input : undefined);
  const databaseSchemas = query?.sql ? Object.values(context.schemas ?? {}).filter(schema => schema.resource === query.resource
    && (query.tables?.some(table => table.database === schema.database && table.table === schema.table)
      || !query.tables && schema.database === query.database && /^[A-Za-z0-9_]+$/.test(schema.table)
      && new RegExp('\\b' + schema.table + '\\b', 'i').test(query.sql))) : undefined;
  return { requirement: check.requirement, channel: check.channel, type: check.type, unit: check.unit,
    subject: check.subject, selected, calculation: args.calculation,
    verifiedIdentity: context.verifiedIdentity, planContext: context.planContext, supportingEvidence: context.supportingEvidence,
    request: observation.channel === 'api' ? { path: observation.data.path, method: observation.data.method, status: observation.data.status, request: observation.data.request } : undefined,
    responseOutcome: observation.channel === 'api' && observation.data.body && !Array.isArray(observation.data.body)
      ? Object.fromEntries(Object.entries(observation.data.body).filter(([key]) => /^(?:success|ok|code|error|errorCode|message)$/.test(key))) : undefined,
    query, databaseSchemas, databaseEvidence: observation.data.databaseEvidence,
    ...(observation.data.primaryKey ? { primaryKey: observation.data.primaryKey } : {}),
    page: check.channel === 'page' ? { url: observation.data.url, ready: observation.data.ready, dom: observation.data.dom,
      domRecords: observation.data.domRecords } : undefined,
    sources: evidence };
}

export function compareAgentObservation(check, observation, args) {
  if (check.type === 'list') {
    const value = observationAt(observation.data, args.field);
    const compared = observation.channel === 'database' && observation.data.primaryKey?.complete === true
      && isDeepStrictEqual(args.field, ['primaryKey', 'columns']) && Array.isArray(value);
    return { assertion: check.id, fragment: check.requirement, field: args.field, expected: check.expected,
      observed: value, compared, passed: compared && isDeepStrictEqual(value, check.expected),
      ...(!compared ? { reason: 'Use the complete primaryKey.columns from test_schema' } : {}) };
  }
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
