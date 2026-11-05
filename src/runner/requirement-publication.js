import { digest, fileToken, RequirementWait } from './requirement-feishu.js';

export function versionNames(title, now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit',
  }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const folderName = parts.year + '年' + parts.month + '月版本';
  const name = title.trim().replace(/测试用例$/, '');
  return { folderName, title: name + (/版本$/.test(name) ? '' : folderName) + '测试用例' };
}

function unique(files, name, type) {
  const matches = files.filter(file => file.name === name);
  if (matches.length > 1 || matches.some(file => file.type !== type)) {
    throw new RequirementWait('publication_conflict', '飞书目录存在同名冲突，请核对后在本话题回复继续。');
  }
  return matches[0];
}

export async function publishCases({ client, settings, source, template, manifest, journal, save, revisionTag }) {
  const domain = settings.document.domain;
  const rootToken = fileToken(settings.projectFolderUrl, domain, 'drive/folder');
  const templateToken = fileToken(settings.templateUrl, domain, 'sheets');
  const names = versionNames(source.title, journal.startedAt, settings.timeZone);
  if (revisionTag) names.title = names.title.replace(/测试用例$/, ' ' + revisionTag + ' 测试用例');
  if (settings.explicitProjectFolder) names.folderName = null;
  const fingerprint = digest([rootToken, templateToken, names, manifest]);
  if (journal.publication && journal.publication.fingerprint !== fingerprint) {
    throw new RequirementWait('publication_version', '发布配置或用例已变化，请保留本轮回执并由管理员核对。');
  }
  if (!journal.publication) {
    journal.publication = { fingerprint, ...names };
    await save();
  }
  const receipt = journal.publication;
  let folder = names.folderName ? unique(await client.listFolder(rootToken), names.folderName, 'folder') : { token: rootToken };
  if (!folder) {
    if (receipt.folderToken || receipt.folderIntent) throw new RequirementWait('publication_receipt', '版本目录创建结果未确认，请核对飞书目录后回复继续。');
    receipt.folderIntent = true;
    await save();
    const folderToken = await client.createFolder(rootToken, names.folderName);
    folder = { token: folderToken };
  }
  if (receipt.folderToken && receipt.folderToken !== folder.token) throw new RequirementWait('publication_version', '本轮版本目录已移动或被替换。');
  receipt.folderToken = folder.token;
  await save();

  const expected = [manifest.headers, ...manifest.rows];
  let file = unique(await client.listFolder(folder.token), names.title, 'sheet');
  if (!receipt.copyIntent) {
    if (file) throw new RequirementWait('publication_conflict', '该版本目录已有同名用例。请核对归属，避免覆盖已存在的用例。');
    receipt.copyIntent = true;
    await save();
    file = await client.copyWorkbook(templateToken, folder.token, names.title);
    receipt.fileToken = file.token;
    await save();
  }
  if (!file || (receipt.fileToken && file.token !== receipt.fileToken)) {
    throw new RequirementWait('publication_receipt', '复制结果或文件位置未确认。已保存回执，等待原目录出现本轮文件。');
  }

  const copied = await client.workbook(file.token);
  if (digest(copied.sheets.map(sheet => sheet.title)) !== digest(template.tabs)) {
    throw new RequirementWait('publication_conflict', '复制后的工作簿页签与模板不一致。');
  }
  const sheet = copied.sheets.find(item => item.title === '测试场景');
  const read = async grid => client.readGrid(file.token, grid, grid.grid_properties.row_count, manifest.headers.length);
  // Published case definitions are immutable. Execution annotations belong to
  // their author and are neither overwritten nor imported as this job's results.
  const verify = async (actual, revision) => {
    if (!receipt.verified) return equalMatrix(actual, expected);
    const comparison = comparePublishedCases(actual, expected);
    if (!comparison.matches) {
      receipt.contentConflict = { at: new Date().toISOString(), revision, cells: comparison.conflicts };
      await save();
      return false;
    }
    if (comparison.annotations.length) {
      const hash = digest(comparison.annotations);
      receipt.annotationSnapshots ??= [];
      if (!receipt.annotationSnapshots.some(item => item.hash === hash)) {
        receipt.annotationSnapshots.push({ at: new Date().toISOString(), revision, hash,
          source: 'external-workbook-annotations', importedAsResults: false, cells: comparison.annotations });
        await save();
      }
    }
    if (revision !== receipt.revision || comparison.annotations.length) receipt.lastVerifiedRevision = revision;
    delete receipt.contentConflict;
    return true;
  };
  const before = await read(sheet);
  if (!await verify(before, copied.revision)) {
    if (!receipt.fileToken || receipt.verified) {
      throw new RequirementWait('publication_conflict', '飞书文件内容与本轮不符，请核对文件归属和版本。');
    }
    if (before.some((row, i) => row.some((cell, col) =>
      !sameCell(cell, template.values[i]?.[col] ?? '') && !sameCell(cell, expected[i]?.[col] ?? '')))) {
      throw new RequirementWait('publication_conflict', '飞书副本已有本轮之外的改动，请管理员核对。');
    }
    await client.writeWorkbook(file.token, sheet, expected);
  }
  for (const tab of copied.sheets.filter(item => item.sheet_id !== sheet.sheet_id)) {
    const examples = template.examples?.[tab.title];
    if (!examples?.length) throw new RequirementWait('case_sheet', '模板附页无法核验。');
    const current = await client.readGrid(file.token, tab, tab.grid_properties.row_count, tab.grid_properties.column_count);
    const header = [examples[0]];
    if (equalMatrix(current, header)) continue;
    if (receipt.verified || !receipt.fileToken || digest(current[0]) !== digest(header[0])
      || current.slice(1).some((row, i) => row.some((cell, col) => cell !== '' && !sameCell(cell, examples[i + 1]?.[col])))) {
      throw new RequirementWait('publication_conflict', '用例附页含本轮之外的编辑，请先核对。');
    }
    await client.writeWorkbook(file.token, tab, header);
    const verified = await client.readGrid(file.token, tab, tab.grid_properties.row_count, tab.grid_properties.column_count);
    if (!equalMatrix(verified, header)) throw new RequirementWait('publication_version', '用例附页回读仍包含模板旧数据。');
  }
  file = unique(await client.listFolder(folder.token), names.title, 'sheet');
  if (!file?.url) throw new RequirementWait('publication_receipt', '飞书目录尚未返回已发布文件的链接。');
  if (file.token !== (receipt.fileToken ?? file.token)) throw new RequirementWait('publication_conflict', '发布过程中同名文件被替换。');
  const after = await client.workbook(file.token);
  const verifiedSheet = after.sheets.find(item => item.sheet_id === sheet.sheet_id);
  if (!verifiedSheet || !await verify(await read(verifiedSheet), after.revision)) {
    throw new RequirementWait('publication_version', '已发布用例未通过逐单元格回读核对。');
  }
  // A revision alone also changes for result annotations. Content, row order,
  // headers and auxiliary tabs were independently checked above.
  Object.assign(receipt, { fileToken: file.token, url: file.url, sheetId: sheet.sheet_id,
    version: digest(expected), revision: receipt.verified ? receipt.revision : after.revision, verified: true });
  await save();
  return receipt;
}

function equalMatrix(actual, expected) {
  return actual.length >= expected.length && digest(actual.slice(0, expected.length)) === digest(expected)
    && actual.slice(expected.length).every(row => row.every(cell => cell === ''));
}

function sameCell(left, right) {
  return left === right || (left && right && typeof left === 'object' && typeof right === 'object' && digest(left) === digest(right));
}

function comparePublishedCases(actual, expected) {
  const annotationHeaders = new Set(['测试结果', '备注说明', '测试截图']);
  const annotations = [], conflicts = [];
  for (let row = 0; row < Math.max(actual.length, expected.length); row++) {
    for (let col = 0; col < Math.max(actual[row]?.length ?? 0, expected[row]?.length ?? 0); col++) {
      const value = actual[row]?.[col] ?? '', original = expected[row]?.[col] ?? '';
      if (sameCell(value, original)) continue;
      const cell = { row: row + 1, column: col + 1, header: expected[0]?.[col] ?? '', value, original };
      if (row > 0 && row < expected.length && annotationHeaders.has(expected[0]?.[col])) annotations.push(cell);
      else conflicts.push(cell);
    }
  }
  if (actual.length < expected.length) conflicts.push({ reason: 'missing-case-rows', expectedRows: expected.length, actualRows: actual.length });
  return { matches: conflicts.length === 0, annotations, conflicts };
}
