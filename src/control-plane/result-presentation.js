import { createHash } from 'node:crypto';
import { cardMarkdownEmphasis } from './card-markdown-emphasis.js';
import { cardMarkdownSegments, cardMarkdownTables, nativeCardTable, fitNativeCardTables } from './card-markdown-tables.js';

const clip = (text, size) => Array.from(text).slice(0, size).join('');
export const PRIMARY_RESPONSE_LIMIT = 1200;
export const PRIMARY_ANALYSIS_LIMIT = 2400;
const TECHNICAL_APPENDIX_HEADING = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:技术依据|源码与数据依据|代码与数据依据|技术细节)\s*[：:]?\s*(?:\*\*)?\s*[：:]?\s*(?=\n|$)/i;
export function publicText(text) {
  // Decode legacy escaping before redaction, then escape markup exactly once.
  return String(text ?? '').replace(/&amp;/g, '&')
    .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (raw, hex, dec) => {
      const n = parseInt(hex ?? dec, hex ? 16 : 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
    }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, '[密钥已隐藏]')
    .replace(/\b(?:Bearer\s+|sk-)[\w.+\-/=]+/gi, '[凭据已隐藏]')
    .replace(/((?:password|passwd|secret|access[_-]?token|api[_-]?key|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/&/g, '&amp;').replace(/</g, '&#60;').replace(/>/g, '&#62;');
}

function cleanedMarkdown(text) {
  return publicText(text).replace(/&#60;/g, '＜').replace(/&#62;/g, '＞')
    .replace(/\[([^\]\n]+)\]\((?!https?:\/\/)[^\n)]*\)/gi, '$1')
    .replace(/(^|[\s`(])\/?[a-z]:[\\/][^\s`<>）)]*/gi, (_, prefix) => `${prefix}[本机路径]`)
    .replace(/(^|[\s`(])\/(?:Users|home)\/[^\s`<>）)]*/g, (_, prefix) => `${prefix}[本机路径]`)
    .replace(/^\s*\[(?:READY|NEEDS_CLARIFICATION|BLOCKED)\]\s*/i, '')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
}

export function readableMarkdown(text) {
  return cardMarkdownEmphasis(cardMarkdownTables(cleanedMarkdown(text))).trim();
}

export function readableMarkdownWithTables(text) {
  return cardMarkdownEmphasis(cleanedMarkdown(text)).trim();
}

export function conciseSummary(text) {
  const cleaned = readableMarkdown(text).replace(/```[\s\S]*?```/g, '[代码示例见详情]')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/[*`]/g, '').trim();
  if (Array.from(cleaned).length <= PRIMARY_RESPONSE_LIMIT) return cleaned;
  const prefix = clip(cleaned, PRIMARY_RESPONSE_LIMIT - 40);
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('\n'));
  return `${boundary > 400 ? prefix.slice(0, boundary + 1) : prefix + '…'}\n详情含完整证据与未验证事项。`;
}

export function conversationPrimaryResult(text) {
  const cleaned = readableMarkdownWithTables(text).replace(/```[\s\S]*?```/g, '[代码示例见详情]')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').trim();
  if (Array.from(cleaned).length <= PRIMARY_RESPONSE_LIMIT) return cleaned;
  const prefix = clip(cleaned, PRIMARY_RESPONSE_LIMIT - 40);
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('\n'));
  return `${boundary > 400 ? prefix.slice(0, boundary + 1) : prefix + '…'}\n详情含完整证据与未验证事项。`;
}

export function analysisPrimaryResult(text) {
  const cleaned = readableMarkdownWithTables(text).replace(/```[\s\S]*?```/g, '[代码及原始技术片段见完整详情]').trim();
  const technicalAppendix = cleaned.match(TECHNICAL_APPENDIX_HEADING);
  let businessAnswer = technicalAppendix?.index > 0 ? cleaned.slice(0, technicalAppendix.index).trim() : cleaned;
  if(technicalAppendix?.index>0){
    const appendix=cleaned.slice(technicalAppendix.index+technicalAppendix[0].length);
    // A generic heading cannot classify the requested structured answer as provenance.
    const boundary=appendix.search(/(?:^|\n)\s*\*\*(?:源码(?:复核|引用|定位|依据|位置)|代码(?:引用|定位|位置)|证据时间|环境[、及与，, ]*(?:版本|验证)|版本[与及、 ]*验证|执行(?:过程|记录)|查询记录)[^\n]*\*\*/i);
    const structuredAnswer=boundary<0?appendix:appendix.slice(0,boundary);
    if(cardMarkdownSegments(structuredAnswer).some(x=>x.type==='table'))businessAnswer+='\n\n'+structuredAnswer.trim();
  }
  // Preserve complete rows. The delivery byte budget is handled separately;
  // character clipping must never turn half a table into ordinary Markdown.
  if(cardMarkdownSegments(businessAnswer).some(x=>x.type==='table'))return businessAnswer+(technicalAppendix?.index>0?'\n\n源码位置与查询证据见下方完整详情。':'');
  const appendixNote = technicalAppendix?.index > 0 ? '\n\n源码位置、表字段、版本与查询证据见下方完整详情。' : '';
  if (Array.from(businessAnswer + appendixNote).length <= PRIMARY_ANALYSIS_LIMIT) return businessAnswer + appendixNote;
  const prefix = clip(businessAnswer, PRIMARY_ANALYSIS_LIMIT - 40);
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('\n'));
  return `${boundary > 900 ? prefix.slice(0, boundary + 1) : prefix + '…'}\n\n完整技术详情与证据见下方。`;
}

// Enforce the existing delivery envelope without changing canonical results,
// task status or queries. Full resultText/details remain available for paging.
export function fitResultCard(card,maxBytes=28000){
 card=fitNativeCardTables(card);
 if(Buffer.byteLength(JSON.stringify(card))<=maxBytes)return card;
 const copy=structuredClone(card),elements=copy.body?.elements;
 if(!elements?.some(x=>x.element_id==='result_details'))return card;
 const tables=elements.filter(x=>x.tag==='table'),total=tables.reduce((n,x)=>n+x.rows.length,0);
 const note={tag:'markdown',text_size:'notation',content:'主卡内容超出消息容量；其余内容保留在下方完整结果分页中，无需重新查询。'};
 elements.splice(elements.findIndex(x=>x.element_id==='result_details'),0,note);
 while(Buffer.byteLength(JSON.stringify(copy))>maxBytes){
  const table=[...elements].reverse().find(x=>x.tag==='table');
  if(table){table.rows.pop();if(!table.rows.length)elements.splice(elements.indexOf(table),1);else table.page_size=Math.min(table.page_size,table.rows.length);continue;}
  // Unusually wide tables fall back to Markdown; retain their complete details.
  const answer=elements.findIndex(x=>x.tag==='column_set'&&x.columns?.some(c=>c.elements?.some(e=>e.tag==='markdown'&&e.text_size!=='notation')));
  if(answer>=0){elements.splice(answer,1);continue;}
  // Converted table prose also consumes bytes. Canonical details/pages are
  // unchanged; remove only answer prose, never actions, status or details.
  const prose=elements.findLastIndex(x=>x.tag==='markdown'&&x!==note);
  if(prose<0)break;elements.splice(prose,1);
 }
 const shown=elements.filter(x=>x.tag==='table').reduce((n,x)=>n+x.rows.length,0);
 if(total)note.content=`主卡表格展示 ${shown}/${total} 行；完整内容保留在下方结果分页中，无需重新查询。`;
 // The count adds a few bytes; reserve its actual serialized cost, not a row cap.
 while(Buffer.byteLength(JSON.stringify(copy))>maxBytes){const t=[...elements].reverse().find(x=>x.tag==='table');if(!t)break;t.rows.pop();if(!t.rows.length)elements.splice(elements.indexOf(t),1);else t.page_size=Math.min(t.page_size,t.rows.length);note.content=`主卡表格展示 ${elements.filter(x=>x.tag==='table').reduce((n,x)=>n+x.rows.length,0)}/${total} 行；完整内容保留在下方结果分页中，无需重新查询。`;}
 return copy;
}

export function analysisPrimarySegments(text) {
  return cardMarkdownSegments(analysisPrimaryResult(text));
}

function primaryCardElements(text) {
  return cardMarkdownSegments(text).map((segment) => segment.type === 'table' ? (nativeCardTable(segment) ?? {
    tag: 'markdown', content: cardMarkdownTables(`| ${segment.headers.join(' | ')} |\n| ${segment.headers.map(() => '---').join(' | ')} |\n${segment.rows.map(row => `| ${row.join(' | ')} |`).join('\n')}`), text_size: 'normal', margin: '0px',
  }) : { tag: 'markdown', content: segment.text.trim(), text_size: 'normal', margin: '0px' }).filter((element) => element.tag === 'table' || element.content);
}

export function analysisPrimaryCardElements(text) {
  return primaryCardElements(analysisPrimaryResult(text));
}

export function conversationPrimaryCardElements(text) {
  return primaryCardElements(conversationPrimaryResult(text));
}

// Split compact numbered prose for narrow message cards without changing its claims.
export function summaryParagraphs(text) {
  return String(text ?? '').replace(/([^\n])\s+([1-9][)）])\s*/g, '$1\n\n$2 ')
    .split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
}

// Small pages bound card bytes. Preserve paragraphs and balance code fences on every page.
export function resultPages(text) {
  const source = readableMarkdown(text);
  if (!source) return [];
  const pages = [];
  let page = '', fence = '';
  const flush = () => {
    if (page.trim()) pages.push(page + (fence ? '\n```' : ''));
    page = fence ? `${fence}\n` : '';
  };
  for (const line of source.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (page.length > 1300) flush();
      fence = fence ? '' : `\`\`\`${marker[2].trim()}`;
      page += `${fence || '```'}\n`;
      continue;
    }
    const points = Array.from(line);
    const chunks = points.length ? Array.from({ length: Math.ceil(points.length / 1300) }, (_, i) => points.slice(i * 1300, (i + 1) * 1300).join('')) : [''];
    for (const chunk of chunks) {
      if (page.length + chunk.length > 1800) flush();
      page += `${chunk}\n`;
    }
  }
  flush();
  return pages;
}

export const detailVersion = (pages) => createHash('sha256').update(JSON.stringify(pages)).digest('hex').slice(0, 16);
export function resultPanel(pages, index = 0, expanded = false) {
  const version = detailVersion(pages);
  const elements = [{ tag: 'markdown', content: pages[index], text_size: 'normal' }];
  if (pages.length > 1) {
    elements.push({ tag: 'column_set', flex_mode: 'none', columns: [-1, 1].map((direction) => ({
      tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button', type: direction === 1 ? 'primary_filled' : 'default', width: 'fill',
        disabled: index + direction < 0 || index + direction >= pages.length,
        text: { tag: 'plain_text', content: direction === 1 ? '下一页详情' : '上一页详情' },
        behaviors: [{ type: 'callback', value: { action: 'result_page', page: index + direction, version } }],
      }],
    })) });
  }
  return { tag: 'collapsible_panel', element_id: 'result_details', expanded, padding: '12px',
    header: { title: { tag: 'plain_text', content: `查看完整技术详情与证据 · ${index + 1}/${pages.length}` } }, elements };
}

export function withResultPage(card, pages, index = 0, expanded = false) {
  const copy = structuredClone(card);
  const elements = copy.body.elements.filter((item) => item.element_id !== 'result_details');
  if (pages.length) elements.push(resultPanel(pages, index, expanded));
  copy.body.elements = elements;
  return copy;
}
