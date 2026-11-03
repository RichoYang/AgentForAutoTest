const OPEN_ID = /^ou_[A-Za-z0-9]+$/;

export function requesterMentionText(userId, message) {
  if (!OPEN_ID.test(String(userId ?? ''))) return null;
  return `<at user_id="${userId}"></at> ${message}`;
}

export function conversationTerminalMention(turn) {
  if (turn.setupPending) return null;
  if (turn?.chatType !== 'group' || turn.outcome?.jobId || turn.outcome?.nextJobId) return null;
  return mention(turn.messageId, turn.profile, turn.senderId, turn.aiFailed ? '本次请求处理失败，尚未创建或推进任务，请查看上方原因。' : turn.actionError ? '本次操作未执行，请查看上方原因。' : '本次回复已完成，请查看上方结果。');
}

export function jobTerminalMention(job, projects = {}) {
  if(job.setupTurnId)return null;
  if(job.connectionEnrollmentPending && !job.connectionEnrollmentHandled && job.status === 'completed' && job.result?.investigation?.status !== 'wait') return null;
  if (job?.originChatType !== 'group' || job.nextJobId) return null;
  if(job.status==='awaiting_clarification'&&job.result?.browserLoginRequired){
    const ids=(job.environmentAccess?.approvalOwnerIds??[]).filter(id=>OPEN_ID.test(id));
    const instruction = job.result?.browserActionRequired === 'automation'
      ? ' 请在运行AgentOS的Mac上放行系统对Chrome的自动化访问；放行后自动继续原问题，不用回复继续。'
      : ['request_blocked','access_check_failed'].includes(job.result.browserLoginState) ? ' 已保存的登录信息无需重发；登录链路或请求范围尚未恢复，请维护者核对，恢复后自动继续原问题。'
      : job.result.browserLoginState==='rejected' ? ' 网站拒绝了本次登录，请核对账号状态并安全更新本机凭据；不会反复自动提交失败的密码。'
      : job.result.browserLoginState==='verification_required' ? ' 已保存账号无需重发；请仅在本机页面完成验证码、扫码或本人确认，完成后自动继续。'
      : job.result.browserCredentialState==='unavailable' ? ' 当前未能读取本应用凭据；首次使用请安全配置，若以前已保存，请维护者核对钥匙串和应用绑定，无需反复发送密码。'
      : ` 正在检查本机已保存的账号并恢复登录：${job.result?.loginUrl || '卡片中显示的网站'}。已有凭据无需重发；如需验证码或本人确认，会在原卡说明。`;
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
  const result = mention(turn.messageId, turn.profile, turn.senderId, turn.outcome?.contactImage
    ? '查询已完成，请查看私有结果。' : '本次回复已结束，请查看私有结果。');
  return result ? { ...result, kind: 'directory_completion' } : null;
}
