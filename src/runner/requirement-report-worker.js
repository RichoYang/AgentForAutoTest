import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { digest } from './requirement-feishu.js';

// This reader runs outside the layout renderer's native context. It verifies
// the saved XLSX, rather than trusting the renderer's in-memory workbook.
export async function verifyReportWorkbook(builder, output, payload) {
  const library = createRequire(builder).resolve('@oai/artifact-tool');
  const { FileBlob, SpreadsheetFile } = await import(pathToFileURL(library).href);
  const file = await FileBlob.load(output);
  const workbookReadbackSha256 = createHash('sha256').update(file.data).digest('hex');
  const workbook = await SpreadsheetFile.importXlsx(file);
  const summary = workbook.worksheets.getItem('测试汇总');
  const detail = workbook.worksheets.getItem('验证明细');
  const { cases } = payload;
  const statuses = ['通过', '失败', '阻断', '未执行', '不适用'];
  const expected = new Map(cases.map(item => [item.case_id, item.status]));
  const totals = Object.fromEntries(statuses.map(status => [status, cases.filter(item => item.status === status).length]));
  const actual = summary.getRange('A4:B8').values;
  if (expected.size !== cases.length || actual.some(([status, count], index) => status !== statuses[index] || count !== totals[status])) {
    throw new Error('Report summary counts differ from the execution records');
  }
  if (cases.length) {
    const rows = detail.getRange('A3:M' + (cases.length + 2)).values;
    for (const row of rows) {
      if (!expected.has(row[0]) || expected.get(row[0]) !== row[12]) throw new Error('Report case ID or status differs from the execution record');
      expected.delete(row[0]);
    }
  }
  const workbookDataCounts = {};
  for (const [name, section, key] of [
    ['前置数据构造矩阵', 'prerequisites', 'prerequisite_id'],
    ['前置数据构造与清理清单', 'mutation_ledger', 'mutation_id'],
    ['清理记录', 'cleanup_records', 'cleanup_id'],
  ]) {
    const expected = payload[section].map(row => row[key]).sort();
    const sheet = workbook.worksheets.getItem(name);
    if (expected.length) {
      const actual = sheet.getRange('A3:A' + (expected.length + 2)).values.flat().sort();
      if (digest(actual) !== digest(expected)) throw new Error('Report data ledger differs from the execution records');
    } else if (!String(sheet.getRange('A3').values[0][0]).startsWith('本次无数据/不适用')) {
      throw new Error('Unexpected report data ledger rows');
    }
    workbookDataCounts[section] = expected.length;
  }
  return { workbookCounts: totals, workbookDataCounts, workbookReadbackSha256, readerPid: process.pid };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , mode, builder, output, input, previewDir] = process.argv;
  const payload = JSON.parse(await readFile(input, 'utf8'));
  let result;
  if (mode === 'layout') {
    const { fitReportRows } = await import('./requirement-report.js');
    await fitReportRows(builder, output, previewDir, payload);
    result = { layoutCompleted: true, workerPid: process.pid };
  } else if (mode === 'verify') {
    result = await verifyReportWorkbook(builder, output, payload);
  } else throw new Error('Unknown report worker mode');
  await new Promise(resolve => process.stdout.write(JSON.stringify(result), resolve));
  process.exit(0);
}
