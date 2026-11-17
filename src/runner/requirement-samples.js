import { digest, RequirementWait } from './requirement-feishu.js';
import { verifiedMutationCleanup } from './requirement-mutation-measurement.js';
import { observationAt } from './requirement-assertions.js';

// Task-owned specimens; business rules and amounts live in the case/configuration.
export function sampleLifecycle(journal, index, jobId, save) {
  journal.samples ??= {};
  const ids = new Set(index.map(item => item.caseId));
  const get = id => {
    const sample = journal.samples[id];
    if (!sample || sample.jobId !== jobId) throw new RequirementWait('sample_scope', '样本不属于当前任务。');
    return sample;
  };
  const active = sample => sample.released !== true && (sample.retainReason
    || sample.caseIds.some(id => !journal.results?.[id] || ['阻断', '未执行'].includes(journal.results[id].status)));
  return {
    get,
    retained(mutation) { return Boolean(mutation.intent?.sampleId && active(get(mutation.intent.sampleId))
      || Object.values(journal.samples).some(sample => sample.ownershipProof?.mutationKey === mutation.key && active(sample))); },
    async register(input) {
      if (!input.id || !input.businessKey || !input.caseIds?.length || input.caseIds.some(id => !ids.has(id))
        || !input.initialEvidence?.length || input.initialState === undefined || input.budgetSnapshot === undefined
        || !input.cleanupOwner || input.restoreValue === undefined) throw new RequirementWait('sample_scope', '样本缺任务用例、实际单号、初态账务证据或清理责任。');
      const definition = { ...input, jobId };
      if (input.originMutationKey) {
        const origin = journal.mutations?.find(item => item.key === input.originMutationKey);
        if (!origin || origin.phase !== 'applied' || origin.intent.operation !== 'create' || origin.intent.resource !== input.resource
          || !String(origin.intent.businessKey).includes('AOS_' + jobId.replaceAll('-', '_')) || !input.businessKeyField?.length
          || observationAt(origin.receipt?.observed, input.businessKeyField) !== input.businessKey || !origin.receipt?.evidence?.length) {
          throw new RequirementWait('sample_scope', '系统生成单号必须关联本任务已核验的创建回执及精确字段。');
        }
        definition.ownershipProof = { mutationKey: origin.key, resource: origin.intent.resource, businessKeyField: input.businessKeyField, evidence: origin.receipt.evidence };
      }
      if (Object.values(journal.samples).some(sample => sample.id !== input.id && sample.businessKey === input.businessKey && sample.resource === input.resource)) throw new RequirementWait('sample_scope', '同一资源单据不能登记成两个并发样本。');
      const prior = journal.samples[input.id];
      if (prior?.released) throw new RequirementWait('sample_scope', '样本已完成清理；新的测试数据须使用新的样本编号和实际单号。');
      if (prior && prior.definitionHash !== digest(definition)) throw new RequirementWait('sample_scope', '已有样本定义不可覆盖。');
      journal.samples[input.id] ??= { ...definition, definitionHash: digest(definition), nodes: {}, createdAt: new Date().toISOString() };
      await save(); return get(input.id);
    },
    async retain(id, { reason, continueAt, nextCondition, owner }) {
      if (!reason || !nextCondition || !owner || continueAt && !Number.isFinite(Date.parse(continueAt))) throw new RequirementWait('sample_scope', '保留样本须说明原因、继续条件、可继续时间及责任方。');
      const sample = get(id);
      if (sample.continueAt && Date.now() < Date.parse(sample.continueAt) && (!continueAt || Date.parse(continueAt) < Date.parse(sample.continueAt))) throw new RequirementWait('sample_wait', '尚未到原可继续时间，不能通过重写保留原因提前解除。');
      (sample.retentionHistory ??= []).push({ at: new Date().toISOString(), reason, continueAt: continueAt ?? null, nextCondition, owner });
      Object.assign(sample, { retainReason: reason, continueAt: continueAt ?? null, nextCondition, owner, released: false });
      await save(); return get(id);
    },
    async release(id, proof) {
      if (!proof?.evidence?.length || proof.actualState === undefined) throw new RequirementWait('sample_scope', '解除保留需要当前状态回读。');
      const sample = get(id);
      if (sample.continueAt && Date.now() < Date.parse(sample.continueAt)) throw new RequirementWait('sample_wait', '尚未到样本可继续时间。');
      sample.releaseProof = proof; delete sample.retainReason; delete sample.nextCondition; delete sample.continueAt;
      await save(); return sample;
    },
    async node(id, nodeId, intent, phase, receipt) {
      const sample = get(id);
      if (sample.released && phase === 'prepared') throw new RequirementWait('sample_scope', '样本已清理，不能重复执行历史节点。');
      if (!nodeId) throw new RequirementWait('sample_scope', '共享样本动作需要稳定节点编号。');
      const node = sample.nodes[nodeId] ??= { intent, intentHash: digest(intent), phase: 'prepared', at: new Date().toISOString() };
      if (node.intentHash !== digest(intent)) throw new RequirementWait('sample_scope', '同一节点的操作意图已变化，禁止重复执行。');
      if (phase === 'applied' && !receipt?.evidence?.length) throw new RequirementWait('mutation_uncertain', '节点缺少实际业务回读。');
      Object.assign(node, { phase: node.phase === 'applied' && phase === 'prepared' ? 'applied' : phase, ...(receipt ? { receipt } : {}) }); await save(); return node;
    },
    records() { return Object.values(journal.samples).filter(active).map(sample => ({
      retained_id: sample.id, identifier: sample.businessKey, location: sample.resource ?? '任务绑定资源',
      reason: sample.retainReason ?? '后续用例仍需此样本',
      deletion_method: sample.nextCondition ?? '关联用例结束后按原快照清理', owner: sample.cleanupOwner,
      case_ids: sample.caseIds, expiry: sample.continueAt ?? '条件满足后', status: '保留',
    })); },
    async finalized(mutations, force = false) {
      for (const sample of Object.values(journal.samples)) {
        const owned = mutations.filter(item => item.intent?.sampleId === sample.id || item.key === sample.ownershipProof?.mutationKey);
        if ((force || !active(sample)) && owned.length && owned.every(verifiedMutationCleanup)) {
          sample.released = true; sample.finalCheck = { at: new Date().toISOString(), mutations: owned.map(item => item.key),
            evidence: owned.flatMap(item => item.cleanup?.evidence ?? []) };
        }
      }
      await save();
    },
  };
}
