import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTerminalMention, jobTerminalMention, requesterMentionText } from '../src/control-plane/requester-mention.js';

test('native mentions accept only Feishu open IDs and group origins', () => {
  assert.equal(requesterMentionText('ou_abc123', '完成'), '<at user_id="ou_abc123"></at> 完成');
  assert.equal(requesterMentionText('all', '完成'), null);
  assert.equal(requesterMentionText('ou_bad\"></at><at user_id="all', '完成'), null);
  assert.equal(conversationTerminalMention({ chatType: 'p2p', messageId: 'm', profile: 'owner', senderId: 'ou_abc123' }), null);
  assert.deepEqual(conversationTerminalMention({ chatType: 'group', messageId: 'm', profile: 'owner', senderId: 'ou_abc123' }), {
    replyTo: 'm', profile: 'owner', text: '<at user_id="ou_abc123"></at> 本次回复已完成，请查看上方结果。',
  });
});

test('task mentions only final mission outcomes and retains the originating bot identity', () => {
  const job = { originChatType: 'group', originMessageId: 'm-origin', replyToMessageId: 'm-latest',
    originProfile: 'owner', senderId: 'ou_abc123', status: 'completed' };
  assert.equal(jobTerminalMention({ ...job, status: 'awaiting_approval' }), null);
  assert.equal(jobTerminalMention({ ...job, nextJobId: 'JOB-next' }), null);
  assert.deepEqual(jobTerminalMention(job), {
    replyTo: 'm-origin', profile: 'owner', text: '<at user_id="ou_abc123"></at> 任务已结束，请查看上方结果。',
  });
});

test('source sync blocks mention origin-profile admins with deduplication and legacy fallback', () => {
  const job = { taskIntent: 'analysis', status: 'blocked', originChatType: 'group', originMessageId: 'm',
    originProfile: 'owner', agentProfile: 'dev', senderId: 'ou_member', result: { sourceSyncBlocked: true } };
  const config = { ownerOpenIdsByProfile: { owner: ['ou_admin', 'ou_admin', 'all'], dev: ['ou_wrongApp'] }, ownerOpenIds: ['ou_legacy'] };
  const text = jobTerminalMention(job, config).text;
  assert.equal((text.match(/<at /g) ?? []).length, 2);
  assert.match(text, /ou_member/); assert.match(text, /ou_admin/);
  assert.doesNotMatch(text, /ou_wrongApp|ou_legacy|user_id="all"/);
  assert.equal((jobTerminalMention({ ...job, senderId: 'ou_admin' }, config).text.match(/<at /g) ?? []).length, 1);
  assert.doesNotMatch(jobTerminalMention(job, { ...config, ownerOpenIdsByProfile: { owner: [] } }).text, /ou_legacy/);
  assert.match(jobTerminalMention(job, { ownerOpenIds: ['ou_legacy'] }).text, /ou_legacy/);
  assert.equal(jobTerminalMention({ ...job, originChatType: 'p2p' }, config), null);
  for (const result of [{}, { finalMessage: '源码同步受阻' }]) {
    assert.doesNotMatch(jobTerminalMention({ ...job, result }, config).text, /ou_admin/);
  }
});

test('successful task actions defer chat mentions to final task outcome, while rejected actions still reply', () => {
  const turn = { chatType: 'group', messageId: 'm', profile: 'owner', senderId: 'ou_requester' };
  for (const action of ['create_task', 'approve', 'clarify', 'cancel']) {
    assert.equal(conversationTerminalMention({ ...turn, decision: { action }, outcome: { jobId: 'J' } }), null);
    assert.ok(conversationTerminalMention({ ...turn, decision: { action }, actionError: 'rejected' }));
  }
  assert.ok(conversationTerminalMention({ ...turn, outcome: {} }));
  assert.equal(jobTerminalMention({ originChatType: 'group', status: 'completed', nextJobId: 'report' }), null);
});

test('partial results and failed tasks notify requester without implying investigation completed',()=>{
 const job={status:'completed',originChatType:'group',originMessageId:'origin',originProfile:'owner',senderId:'ou_abc123',result:{outcome:'partial'}};
 assert.match(jobTerminalMention(job).text,/排查尚未完成/);
 assert.doesNotMatch(jobTerminalMention(job).text,/任务已结束/);
 assert.match(jobTerminalMention({...job,status:'failed',result:{}}).text,/排查受阻/);
});

test('browser automation wait asks for macOS permission instead of another website login', () => {
  const mention = jobTerminalMention({ originChatType:'group', status:'awaiting_clarification',
    result:{browserLoginRequired:true,browserActionRequired:'automation'}, environmentAccess:{approvalOwnerIds:['ou_admin']},
    originMessageId:'m', originProfile:'owner' });
  assert.match(mention.text,/放行系统对Chrome的自动化访问/);
  assert.doesNotMatch(mention.text,/网页登录/);
});

test('automatic website recovery does not mention administrators, including its initial unknown state', () => {
 const base={originChatType:'group',status:'awaiting_clarification',environmentAccess:{approvalOwnerIds:['ou_admin']},originMessageId:'m',originProfile:'owner'};
 for(const state of [undefined,'login_required','loading','waiting'])for(const credentials of [undefined,'unknown','available'])assert.equal(jobTerminalMention({...base,result:{browserLoginRequired:true,browserLoginState:state,browserCredentialState:credentials,loginUrl:'https://jobs.example/xxl-job-admin/'}}),null);
 assert.ok(jobTerminalMention({...base,result:{browserLoginRequired:true,browserCredentialState:'unavailable'}}));
 for(const state of ['credential_unavailable','password_change_required','service_error','request_error','rate_limited'])assert.ok(jobTerminalMention({...base,result:{browserLoginRequired:true,browserLoginState:state}}));
});

test('intake failures never announce a completed reply',()=>{
 const turn={chatType:'group',messageId:'m',profile:'owner',senderId:'ou_requester'};
 for(const extra of [{aiFailed:true},{actionError:'rejected'}]){const text=conversationTerminalMention({...turn,...extra}).text;assert.doesNotMatch(text,/回复已完成/);assert.match(text,/失败|未执行/);}
});

test('login-chain failure, rejection and verification notices do not ask users to resend saved credentials',()=>{
 const base={originChatType:'group',status:'awaiting_clarification',environmentAccess:{approvalOwnerIds:['ou_admin']},originMessageId:'m',originProfile:'owner'};
 for(const state of ['request_blocked','access_check_failed','rejected','verification_required']){const text=jobTerminalMention({...base,result:{browserLoginRequired:true,browserLoginState:state,browserCredentialState:'available'}}).text;assert.doesNotMatch(text,/直接回复.*密码/);assert.match(text,/无需重发|无需重发|安全更新|本机页面/);}
});
