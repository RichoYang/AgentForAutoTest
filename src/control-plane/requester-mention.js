const OPEN_ID = /^ou_[A-Za-z0-9]+$/;

export function requesterMentionText(userId, message) {
  if (!OPEN_ID.test(String(userId ?? ''))) return null;
  return `<at user_id="${userId}"></at> ${message}`;
}

export function conversationTerminalMention(turn) {
  if (turn.setupPending) return null;
  if (turn?.chatType !== 'group' || turn.outcome?.jobId || turn.outcome?.nextJobId) return null;
  return mention(turn.messageId, turn.profile, turn.senderId, '本次回复已完成，请查看上方结果。');
}

export function jobTerminalMention(job, projects = {}) {
  if(job.setupTurnId)return null;
  if(job.connectionEnrollmentPending && !job.connectionEnrollmentHandled && job.status === 'completed') return null;
  if (job?.originChatType !== 'group' || job.nextJobId) return null;
  if (job.workflow === 'requirement_test' && job.status === 'awaiting_clarification') {
    return mention(job.originMessageId, job.originProfile, job.senderId, '需求测试等待处理，请查看本话题的任务卡。');
  }
  if(job.status==='awaiting_clarification'&&job.result?.browserLoginRequired){
    const ids=(job.environmentAccess?.approvalOwnerIds??[]).filter(id=>OPEN_ID.test(id));
    const instruction = job.result?.browserActionRequired === 'automation'
      ? ' 请在运行AgentOS的Mac上放行系统对Chrome的自动化访问；放行后自动继续原问题，不用回复继续。'
      : ` 当前需要登录：${job.result?.loginUrl || '卡片中显示的网站'}。可在运行AgentOS的电脑上登录，或直接回复本任务卡“账号 / 密码”；无需固定格式，登录后自动继续。`;
    return ids.length?{kind:'browser_login',replyTo:job.originMessageId??job.replyToMessageId,profile:job.originProfile,text:ids.map(id=>`<at user_id="${id}"></at>`).join(' ')+instruction}:null;
  }
  if (job.status === 'awaiting_environment_approval') {
    const ids = job.environmentAccess?.approvalOwnerIds ?? [];
    if (!ids.length) return null;
    return { kind: 'environment_approval', replyTo: job.originMessageId ?? job.replyToMessageId, profile: job.originProfile,
      text: `${ids.filter((id) => OPEN_ID.test(id)).map((id) => `<at user_id="${id}"></at>`).join(' ')} 请审核原卡中的环境、查询范围、参数及结果展示范围；未批准前不会访问环境。` };
  }
  if (!['completed', 'blocked', 'failed', 'cancelled'].includes(job.status)) return null;
  const replyTo = job.originMessageId ?? job.replyToMessageId;
  if (job.taskIntent === 'analysis' && job.status === 'blocked' && job.result?.sourceSyncBlocked === true) {
    const administrators = projects.ownerOpenIdsByProfile?.[job.originProfile] ?? projects.ownerOpenIds ?? [];
    const ids = [...new Set([job.senderId, ...(Array.isArray(administrators) ? administrators : [])])]
      .filter((id) => OPEN_ID.test(String(id ?? '')));
    if (!replyTo || !ids.length) return null;
    return { replyTo, profile: job.originProfile ?? null,
      text: `${ids.map((id) => `<at user_id="${id}"></at>`).join(' ')} 源码同步受阻，请管理员查看上方原因并决定处理方式；未自动解决冲突。` };
  }
  const message = job.result?.outcome === 'partial' ? '排查尚未完成，请查看上方已确认内容、缺口和下一步。'
    : ['blocked', 'failed'].includes(job.status) || job.result?.outcome === 'blocked' ? '本次排查受阻，请查看上方原因和下一步。'
    : job.status === 'cancelled' ? '任务已取消。' : '任务已结束，请查看上方结果。';
  return mention(replyTo, job.originProfile, job.senderId, message);
}

function mention(replyTo, profile, userId, message) {
  const text = requesterMentionText(userId, message);
  return replyTo && text ? { replyTo, profile: profile ?? null, text } : null;
}

// A deliberately public acknowledgement: never include lookup text or personnel fields.
export function directoryTerminalMention(turn) {
  if (!turn.directoryChannel || turn.setupPending || turn.outcome?.contactCandidates?.length) return null;
  const result = mention(turn.messageId, turn.profile, turn.senderId, (turn.outcome?.contactImage||turn.outcome?.departmentSummary)
    ? '查询已完成，请查看私有结果。' : '本次回复已结束，请查看私有结果。');
  return result ? { ...result, kind: 'directory_completion' } : null;
}
