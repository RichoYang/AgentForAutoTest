import { runLarkCli } from '../control-plane/lark-cli.js';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

export class RequirementWait extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function requirementFeishu(identity, cwd, cliEntry = process.env.LARK_CLI_ENTRY) {
  const call = async (args, input) => {
    try {
      return await runLarkCli(args, { cwd, cliEntry, profile: identity.profile, configDir: identity.configDir, input });
    } catch (error) {
      const code = error.cliError?.code;
      throw new RequirementWait('feishu_access', '飞书操作未成功，请核对文档用户授权、访问权限和网络'
        + (Number.isInteger(code) ? '（错误码 ' + code + '）' : '') + '。');
    }
  };
  const api = async (method, route, input) =>
    (await call(['api', method, route, '--as', 'user', '--format', 'json', ...(input ? ['--data', '-'] : [])],
      input ? JSON.stringify(input) : undefined)).data;

  async function localPreview(anchor, args) {
    const name = 'requirement-media-' + digest(anchor).slice(0, 24);
    const result = await call([...args, '--as', 'user', '--output', name, '--format', 'json']);
    const saved = result.data?.saved_path ?? result.data?.local_path ?? result.data?.path;
    if (!saved) throw new Error('Missing local preview path');
    const file = path.resolve(cwd, saved);
    if (path.dirname(file) !== path.resolve(cwd) || !path.basename(file).startsWith(name)) throw new Error('Invalid local preview path');
    if (!(await lstat(file)).isFile() || path.relative(await realpath(cwd), await realpath(file)) !== path.basename(file)) {
      throw new Error('Invalid local preview file');
    }
    const bytes = await readFile(file);
    const format = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'png'
      : bytes.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'jpeg'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
    if (!format) throw new Error('Preview is not a supported image');
    return { filename: path.basename(file), format, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async function basePages(route) {
    const items = [];
    const seen = new Set();
    let cursor;
    do {
      const page = await api('GET', route + '?page_size=100' + (cursor ? '&page_token=' + encodeURIComponent(cursor) : ''));
      if (!Array.isArray(page?.items)) throw new Error('Missing Base data');
      items.push(...page.items);
      cursor = page.has_more ? page.page_token : undefined;
      if (page.has_more && (!cursor || seen.has(cursor))) throw new Error('Incomplete Base pagination');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }

  return {
    async verify() {
      const auth = await call(['auth', 'status', '--verify', '--json']);
      if (auth.appId !== identity.appId || auth.identities?.user?.openId !== identity.openId
        || auth.identities.user.verified !== true) {
        throw new RequirementWait('feishu_identity', '飞书文档操作身份校验失败，请重新授权指定的用户 profile。');
      }
    },
    async readRequirement(url) {
      const result = await call(['docs', '+fetch', '--api-version', 'v2', '--doc', url,
        '--as', 'user', '--scope', 'full', '--detail', 'with-ids', '--doc-format', 'xml']);
      const doc = result.data?.document;
      if (!doc?.document_id || !doc.revision_id || !doc.content) throw new RequirementWait('requirement_source', '无法读取需求正文和版本。');
      const embedded = [];
      for (const [tag] of doc.content.matchAll(/<sheet\b[^>]*>/gi)) {
        const reference = tag.match(/\b(?:token|spreadsheet-token)="([^"]+)"/)?.[1];
        const [token, tokenSheetId] = (reference ?? '').split('_');
        const sheetId = tag.match(/\bsheet-id="([^"]+)"/)?.[1] ?? tokenSheetId;
        if (!/^[A-Za-z0-9]+$/.test(token)) throw new RequirementWait('requirement_source', '无法解析嵌入表格标识。');
        const book = await this.workbook(token);
        const selected = book.sheets.filter(sheet => !sheetId || sheet.sheet_id === sheetId);
        if (!selected.length) throw new RequirementWait('requirement_source', '嵌入表格缺少指定工作表。');
        for (const sheet of selected) embedded.push({ token, title: sheet.title, sheetId: sheet.sheet_id,
          revision: book.revision, values: await this.readGrid(token, sheet, sheet.grid_properties.row_count, sheet.grid_properties.column_count) });
      }
      const title = doc.content.match(/<title\b[^>]*>(.*?)<\/title>/s)?.[1]?.replace(/<[^>]*>/g, '') || '需求-' + doc.document_id;
      const source = { title, url, id: doc.document_id, revision: doc.revision_id, xml: doc.content, embedded };
      const materials = [];
      const unread = [];
      for (const [tag, kind] of doc.content.matchAll(/<(img|image|whiteboard|bitable|base|mindnote)\b[^>]*>/gi)) {
        const attr = key => tag.match(new RegExp('\\s' + key + '=["\']([^"\']+)["\']', 'i'))?.[1];
        const token = attr('src') ?? attr('token') ?? attr('app-token') ?? attr('file-token');
        const anchor = attr('id') ?? 'material-' + digest(tag).slice(0, 20);
        const type = kind.toLowerCase();
        try {
          if (!/^[A-Za-z0-9_-]+$/.test(token ?? '')) throw new Error('Missing resource identifier');
          if (['base', 'bitable'].includes(type)) {
            const [base, inlineTable] = token.split('_');
            const uri = '/open-apis/bitable/v1/apps/' + base + '/tables';
            const tableId = attr('table-id') ?? inlineTable;
            const tableList = (await basePages(uri)).filter(item => !tableId || item.table_id === tableId);
            if (!tableList.length) throw new Error('Missing Base table');
            const tables = [];
            for (const table of tableList) {
              const records = await basePages(uri + '/' + encodeURIComponent(table.table_id) + '/records');
              const fields = await basePages(uri + '/' + encodeURIComponent(table.table_id) + '/fields');
              if (fields.some(field => field.type === 17)) throw new Error('Base includes attachments');
              tables.push({ id: table.table_id, name: table.name, fields, records });
            }
            materials.push({ anchor, type, token, tables, sha256: digest(tables) });
          } else {
            const args = type === 'mindnote' ? ['drive', '+preview', '--file-token', token, '--type', 'image', '--if-exists', 'overwrite']
              : ['docs', '+media-download', '--token', token, '--type', type === 'whiteboard' ? 'whiteboard' : 'media', '--overwrite'];
            materials.push({ anchor, type, token, ...(await localPreview(anchor, args)) });
          }
        } catch {
          unread.push(type + '（块 ' + anchor + '）');
        }
      }
      if (unread.length) throw new RequirementWait('requirement_source', '未读需求材料：' + unread.join('、')
        + '。请核对飞书文档身份的读取权限；若平台未提供可读取预览，请将对应材料补为图片、表格或正文。');
      return materials.length ? { ...source, materials, legacyHash: digest(source), hash: digest([source, materials]) }
        : { ...source, hash: digest(source) };
    },
    async workbook(token) {
      const uri = '/open-apis/sheets/v3/spreadsheets/' + token;
      const info = await api('GET', uri);
      const listing = await api('GET', uri + '/sheets/query');
      const sheets = listing?.sheets?.sort((a, b) => a.index - b.index);
      if (!sheets?.length) throw new RequirementWait('case_sheet', '飞书工作簿没有可读取的工作表。');
      return { sheets, revision: info.spreadsheet?.revision ?? null };
    },
    async readGrid(token, sheet, rows, columns) {
      const values = [];
      for (let start = 1; start <= rows; start += 200) {
        const end = Math.min(rows, start + 199);
        const range = sheet.sheet_id + '!A' + start + ':' + columnLabel(columns) + end;
        const data = await api('GET', '/open-apis/sheets/v2/spreadsheets/' + token + '/values/' + encodeURIComponent(range));
        if (!data?.valueRange) throw new RequirementWait('case_sheet', '飞书未返回已请求的工作表范围。');
        const items = data?.valueRange?.values;
        for (let index = 0; index <= end - start; index++) {
          values.push(Array.from({ length: columns }, (_, col) => items?.[index]?.[col] ?? ''));
        }
      }
      return values;
    },
    async listFolder(token) {
      const files = [];
      let pageToken;
      do {
        const page = (await call(['drive', 'files', 'list', '--folder-token', token, '--page-size', '200',
          '--as', 'user', '--format', 'json', ...(pageToken ? ['--page-token', pageToken] : [])])).data;
        files.push(...(page.files ?? []));
        pageToken = page.has_more && page.next_page_token;
        if (page.has_more && !pageToken) throw new RequirementWait('case_folder', '未能完整列出飞书目录。');
      } while (pageToken);
      return files;
    },
    async copyWorkbook(token, folder, title) {
      const data = await api('POST', '/open-apis/drive/v1/files/' + token + '/copy', {
        name: title, type: 'sheet', folder_token: folder,
      });
      if (!data?.file?.token) throw new RequirementWait('publication_receipt', '飞书复制回执缺少文件标识，请核对原目录。');
      return data.file;
    },
    async createFolder(parent, name) {
      const data = await api('POST', '/open-apis/drive/v1/files/create_folder', { name, folder_token: parent });
      if (!data?.token) throw new RequirementWait('publication_receipt', '飞书版本目录回执缺少标识。');
      return data.token;
    },
    async writeWorkbook(token, sheet, values) {
      const count = sheet.grid_properties.row_count;
      const columns = values[0].length;
      if (count < values.length) {
        await api('POST', '/open-apis/sheets/v2/spreadsheets/' + token + '/dimension_range', {
          dimension: { sheetId: sheet.sheet_id, majorDimension: 'ROWS', length: values.length - count },
        });
      }
      // Overwrite only the copied test-case tab. Clear leftover example rows without altering formatting.
      const rows = Math.max(count, values.length);
      for (let start = 1; start <= rows; start += 200) {
        const end = Math.min(start + 199, rows);
        const matrix = Array.from({ length: end - start + 1 }, (_, index) => values[start + index - 1] ?? Array(columns).fill(''));
        await api('POST', '/open-apis/sheets/v2/spreadsheets/' + token + '/values_batch_update', {
          valueRanges: [{ range: sheet.sheet_id + '!A' + start + ':' + columnLabel(columns) + end, values: matrix }],
        });
      }
    },
  };
}

export function columnLabel(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new RequirementWait('case_sheet', '工作表范围无效。');
  let label = '';
  for (; number > 0; number = Math.floor((number - 1) / 26)) label = String.fromCharCode(65 + (number - 1) % 26) + label;
  return label;
}

export async function readCaseTemplate(client, token) {
  const workbook = await client.workbook(token);
  const sheet = workbook.sheets.find(item => item.title === '测试场景');
  if (!sheet) throw new RequirementWait('case_sheet', '默认模板缺少测试场景页。');
  const tabs = workbook.sheets.map(item => item.title);
  const values = await client.readGrid(token, sheet, sheet.grid_properties.row_count, 16);
  const examples = {};
  for (const tab of workbook.sheets.filter(item => item.sheet_id !== sheet.sheet_id)) {
    examples[tab.title] = await client.readGrid(token, tab, tab.grid_properties.row_count, tab.grid_properties.column_count);
  }
  return { token, tabs, headers: values[0], values, examples };
}

export function fileToken(value, domain, resource) {
  const url = new URL(value);
  const match = url.pathname.match(new RegExp('^/' + resource + '/([a-zA-Z0-9]+)/?$'));
  if (url.protocol !== 'https:' || url.hostname !== domain || !match) throw new RequirementWait('project_defaults', '飞书项目目录或模板链接不符合已绑定租户。');
  return match[1];
}
