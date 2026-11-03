import { credential } from '../runner/environment-connector.js';
import { isEnvironmentOwner, loadEnvironments } from '../shared/environment-access.js';
import { saveKeychainCredential } from '../shared/keychain-credential.js';

const command = /(?:网站登录|登录网站|网页登录)/i;
const marker = /(?:网址|地址|账号|用户名|密码|(?<![A-Za-z0-9_-])(?:url|user(?:name)?|password|passwd))\s*[:：=]?\s*/ig;

const cleanValue = (value) => String(value ?? '').trim().replace(/^[`'"“”‘’,，;；]+|[`'"“”‘’,，;；]+$/g, '').trim();

export function stripCredentialMentions(value, mentions = []) {
  let text = String(value ?? '');
  for (const mention of mentions ?? []) {
    if (mention?.key) text = text.replaceAll(mention.key, ' ');
    if (mention?.name) text = text.replaceAll(`@${mention.name}`, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function parseWebsiteCredentialMessage(value, { allowLoose = false } = {}) {
  const text = String(value ?? '').trim();
  const credentialShape = /(?:账号|用户名|user(?:name)?)\s*[:：=]?\s*\S+/i.test(text)
    && /(?:密码|password|passwd)\s*[:：=]?\s*\S+/i.test(text);
  if (!allowLoose && !command.test(text) && !credentialShape) return null;
  command.lastIndex = 0;
  const fields = [];
  for (const match of text.matchAll(marker)) fields.push({ key: match[0], name: match[0].match(/网址|地址|url/i) ? 'url'
    : match[0].match(/密码|password|passwd/i) ? 'password' : 'username', start: match.index + match[0].length, marker: match.index });
  const result = { intent: true };
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const valueText = cleanValue(text.slice(field.start, fields[index + 1]?.marker ?? text.length));
    if (valueText && result[field.name] == null) result[field.name] = valueText;
  }
  if (!result.url) { const found = text.match(/https?:\/\/[^\s]+/i)?.[0]; if (found) result.url = found; }
  if (allowLoose && (!result.username || !result.password)) {
    const withoutUrl = text.replace(/https?:\/\/[^\s]+/ig, ' ').replace(command, ' ').trim();
    const split = withoutUrl.match(/^(.{1,1000}?)\s*(?:\/|／|\||｜|,|，|;|；|\n)\s*(.{1,8000})$/s);
    if (split) { result.username = cleanValue(split[1]); result.password = cleanValue(split[2]); }
    else {
      const tokens = withoutUrl.split(/\s+/).filter(Boolean);
      if (tokens.length === 2 && /^[A-Za-z0-9_.@+\\-]+$/.test(tokens[0])) [result.username, result.password] = tokens.map(cleanValue);
    }
  }
  if (typeof result.username !== 'string' || !result.username || result.username.length > 1000
    || typeof result.password !== 'string' || !result.password || result.password.length > 8000) result.invalid = true;
  return result;
}

export class WebsiteCredentialService {
  constructor(context, adapters = {}) {
    this.context = context;
    this.save = adapters.save ?? saveKeychainCredential;
    this.read = adapters.read ?? credential;
    this.load = adapters.load ?? loadEnvironments;
  }

  async handle(event) {
    const profile = event.agent_profile ?? null;
    const reply = async (message) => {
      await this.context.feishu.reply(event.message_id ?? event.id, message, { profile });
      return { credentialMessage: true };
    };
    const state = await this.context.store.read();
    const config = await this.load();
    let candidates = state.jobs.filter((job) => job.status === 'awaiting_clarification'
      && job.result?.browserLoginRequired === true && job.result?.browserActionRequired !== 'automation'
      && job.environmentAccess?.kind === 'website').map((job) => ({ job, environment: config.environments[job.environmentAccess.environmentId] }))
      .filter(({ environment }) => environment?.kind === 'website' && isEnvironmentOwner(environment, { profile, senderId: event.sender_id }));
    const replyIds = [event.reply_to, event.root_id, event.thread_id].filter(Boolean);
    const relatedKeys = new Set(Object.entries(state.cardMessages ?? {}).filter(([, card]) => replyIds.includes(card.messageId)
      && card.destination?.profile === profile && (!card.destination.chatId || card.destination.chatId === event.chat_id)).map(([key]) => key));
    const related = candidates.filter(({ job }) => {
      const question = state.questions?.[job.questionId];
      return relatedKeys.has(`question:${job.questionId}`)
        || [...relatedKeys].some((key) => key.startsWith(`job:${job.id}:`))
        || job.notificationIds?.some((id) => replyIds.includes(id))
        || [question?.messageId, question?.threadRootId].some((id) => replyIds.includes(id));
    });
    const contextual = related.length > 0;
    if (contextual) candidates = related;
    else if (event.chat_type === 'group') candidates = candidates.filter(({ job }) => job.chatId === event.chat_id && job.agentProfile === profile);
    const parsed = parseWebsiteCredentialMessage(stripCredentialMentions(event.content, event.mentions), { allowLoose: contextual && candidates.length === 1 });
    if (!parsed) return null;
    if (event.chat_type === 'group' && !contextual) return reply('账号密码只能直接回复对应的“等待网页登录”任务卡；这样 AgentOS 才能确定要登录哪个网站。');
    if (parsed.invalid) {
      const site = candidates.length === 1 ? `当前卡片需要登录：${candidates[0].environment.baseUrl}。` : '';
      return reply(`${site}直接回复“账号 / 密码”即可，也支持“账号：… 密码：…”；无需固定模板。`);
    }
    if (parsed.url) {
      let supplied;
      try { supplied = new URL(parsed.url); if (supplied.username || supplied.password || !['http:', 'https:'].includes(supplied.protocol)) throw new Error(); }
      catch { return reply('网址格式无效，请发送不含账号、密码和令牌的 http(s) 网站地址。'); }
      candidates = candidates.filter(({ environment }) => {
        const base = new URL(environment.baseUrl);
        return base.origin === supplied.origin && (supplied.pathname.startsWith(base.pathname) || base.pathname.startsWith(supplied.pathname));
      });
    }
    candidates = [...new Map(candidates.map((candidate) => [candidate.job.environmentAccess.environmentId, candidate])).values()];
    if (!candidates.length) return reply('没有找到由你负责且正在等待登录的网站任务。请直接回复显示“等待网页登录”的任务卡。');
    if (candidates.length > 1) return reply(`当前有多个网站等待登录：${candidates.map(({ environment }, index) => `${index + 1}. ${environment.baseUrl}`).join('；')}。请直接回复对应任务卡，或在消息中带上网址。`);
    const { job, environment } = candidates[0];
    await this.save(environment.credentialRef, { username: parsed.username, password: parsed.password });
    let result;
    try { result = await this.context.websiteBrowser.submitCredentials(job, environment, { username: parsed.username, password: parsed.password }, { force: true }); }
    catch { return reply('凭据已安全保存到 Mac 钥匙串，但页面自动填写暂未完成。AgentOS 会保留原任务；请确认本机 Chrome 页面仍停留在该网站登录页。'); }
    if (result.authenticated) return reply('凭据已保存到 Mac 钥匙串，网页登录成功。AgentOS 将自动继续原问题，无需回复“继续”。');
    if(result.passwordChangeRequired)return reply('网站要求修改或重置密码，任务已保留。请由本人在本机页面完成；AgentOS 不会代为更改密码。');
    if(result.rateLimited)return reply('登录接口限制了请求频率，原任务已保留；不会反复自动提交凭据。');
    if(result.serviceUnavailable||result.requestFailed)return reply('登录接口返回服务或请求错误，原任务保留；目前不能认定账号密码错误，请维护者检查网站服务与请求链路。');
    if(result.blockedRequests?.length)return reply('登录流程中的接口请求受到访问规则限制，原任务保留；请维护者核对读取范围，当前不能认定密码错误。');
    if(result.submissionUnconfirmed)return reply('凭据已填写，但尚未确认登录请求成功发出；任务保留，请维护者检查登录提交和网络拦截，当前不能认定账号密码错误。');
    if (result.credentialRejected) return reply('账号密码已提交，但页面仍停留在账号密码登录界面，可能是账号或密码未通过。请核对后直接回复本任务卡重新提交；AgentOS 不会在消息或日志中回显凭据。');
    if (result.verificationRequired) return reply('账号密码已提交，页面正在等待验证码、短信或扫码。请只在本机 Chrome 完成该步骤；完成后 AgentOS 会自动继续原问题。');
    return reply('账号密码已提交，但网页尚未返回明确的登录结果。AgentOS 会保留原任务并继续检测；如页面出现人工步骤，请只在本机 Chrome 完成。');
  }

  async autoLogin(job,environment){return Boolean((await this.recoverLogin(job,environment)).authenticated);}

  async recoverLogin(job, environment) {
    if(typeof this.context.websiteBrowser.submitCredentials!=='function')return {authenticated:false,credentialState:'unsupported'};
    try{if((await this.context.websiteBrowser.loginStatusFor?.(job,environment))?.pageReady===true)return {authenticated:true,credentialState:'not_needed'};}catch{return {authenticated:false,credentialState:'access_unavailable'};}
    let saved;
    try{saved=await this.read(environment.credentialRef);}catch{return {authenticated:false,credentialState:'unavailable'};}
    try{const result=await this.context.websiteBrowser.submitCredentials(job,environment,saved);return {authenticated:Boolean(result.authenticated),credentialState:'available',loginState:result.loginState??null};}
    catch{return {authenticated:false,credentialState:'available'};}
  }
}
