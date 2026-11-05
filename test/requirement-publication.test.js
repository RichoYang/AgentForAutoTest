import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishCases } from '../src/runner/requirement-publication.js';

function fixture() {
  const manifest = { headers: ['模块', '测试步骤', '预期结果', '测试结果', '备注说明', '测试截图'],
    rows: [['A', '独立步骤 A', '100', '', '', ''], ['B', '独立步骤 B', '200', '', '', '']] };
  let matrix = [manifest.headers, ...manifest.rows].map(row => [...row]), revision = 1, writes = 0;
  const journal = { startedAt: '2026-11-05T00:00:00Z' }, files = [];
  const sheet = { sheet_id: 'cases', title: '测试场景', grid_properties: { row_count: 10 } };
  const client = {
    listFolder: async token => token === 'Root' ? [{ name: '2026年11月版本', type: 'folder', token: 'Version' }] : files,
    copyWorkbook: async (token, parent, name) => {
      const file = { name, type: 'sheet', token: 'Copy', url: 'https://example.feishu.cn/sheets/Copy' };
      files.push(file); return file;
    },
    workbook: async () => ({ sheets: [sheet], revision }),
    readGrid: async () => structuredClone(matrix),
    writeWorkbook: async () => { writes++; throw new Error('Existing annotations must not be overwritten'); },
  };
  const run = () => publishCases({ client, journal, manifest, source: { title: '示例' },
    settings: { timeZone: 'Asia/Shanghai', document: { domain: 'example.feishu.cn' },
      projectFolderUrl: 'https://example.feishu.cn/drive/folder/Root', templateUrl: 'https://example.feishu.cn/sheets/Template' },
    template: { tabs: ['测试场景'], values: [] }, save: async () => {} });
  return { run, journal, manifest, get matrix() { return matrix; }, set matrix(value) { matrix = value; revision++; },
    get writes() { return writes; } };
}

test('resuming preserves external result annotations and original publication without importing results', async () => {
  const f = fixture();
  await f.run();
  const original = structuredClone(f.journal.publication);
  await f.run();
  assert.deepEqual(f.journal.publication, original);
  const immutable = JSON.stringify(f.manifest);
  const annotated = structuredClone(f.matrix);
  annotated[1].splice(3, 3, '失败', '其他执行者的记录', 'external.png');
  f.matrix = annotated;
  await f.run();
  await f.run();
  assert.deepEqual(f.matrix, annotated);
  assert.equal(f.writes, 0);
  for (const key of ['fileToken', 'sheetId', 'version', 'fingerprint', 'revision']) assert.equal(f.journal.publication[key], original[key]);
  assert.equal(f.journal.publication.lastVerifiedRevision, 2);
  assert.equal(f.journal.publication.annotationSnapshots.length, 1);
  assert.equal(f.journal.publication.annotationSnapshots[0].cells.length, 3);
  assert.equal(f.journal.publication.annotationSnapshots[0].importedAsResults, false);
  assert.equal(f.journal.results, undefined);
  assert.equal(JSON.stringify(f.manifest), immutable);
});

for (const [label, change] of [
  ['step edits', rows => { rows[1][1] = 'changed'; }],
  ['expected result edits', rows => { rows[1][2] = 'wrong'; }],
  ['case reordering', rows => { [rows[1], rows[2]] = [rows[2], rows[1]]; }],
  ['header edits', rows => { rows[0][3] = 'changed'; }],
  ['extra case rows', rows => { rows.push(['', '', '', '通过']); }],
  ['missing cases', rows => { rows.pop(); }],
]) test('resuming rejects ' + label + ' even with external annotations', async () => {
  const f = fixture(); await f.run(); const edited = structuredClone(f.matrix);
  edited[1][4] = 'external note'; change(edited); f.matrix = edited;
  await assert.rejects(f.run(), { code: 'publication_conflict' });
  assert.ok(f.journal.publication.contentConflict.cells.length);
  assert.deepEqual(f.matrix, edited); assert.equal(f.writes, 0);
});
