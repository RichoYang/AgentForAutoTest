// Parse only confirmed GFM tables. First-screen cards can render them with the
// native Card 2.0 table component; folded details still have a vertical fallback.
function cellsOf(line) {
  const source = line.trim();
  const cells = [];
  let cell = '', ticks = 0, separators = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && i + 1 < source.length) {
      cell += char + source[++i];
    } else if (char === '`') {
      let run = 1;
      while (source[i + run] === '`') run++;
      if (!ticks) ticks = run;
      else if (ticks === run) ticks = 0;
      cell += '`'.repeat(run); i += run - 1;
    } else if (char === '|' && !ticks) {
      cells.push(cell.trim()); cell = ''; separators++;
    } else cell += char;
  }
  cells.push(cell.trim());
  if (!separators) return null;
  if (source.startsWith('|')) cells.shift();
  if (cells.at(-1) === '' && source.endsWith('|')) cells.pop();
  return cells;
}

function parsedTable(lines, start) {
  const headers = cellsOf(lines[start]);
  const separator = start + 1 < lines.length ? cellsOf(lines[start + 1]) : null;
  if (!headers || headers.length < 2 || separator?.length !== headers.length
    || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  const rows = [];
  let end = start + 2, invalid = false;
  for (; end < lines.length; end++) {
    const cells = cellsOf(lines[end]);
    if (!cells || /^ {0,3}(`{3,}|~{3,})/.test(lines[end])) break;
    if (cells.length > headers.length) { invalid = true; break; }
    rows.push(cells);
  }
  // Uncertain input is evidence too; never guess away an extra column.
  return rows.length && !invalid ? { headers, rows, end } : null;
}

export function cardMarkdownSegments(text) {
  const lines = String(text ?? '').split('\n'), segments = [];
  let buffer = [];
  let fence = null;
  const flush = () => {
    if (buffer.length) segments.push({ type: 'markdown', text: buffer.join('\n') });
    buffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      buffer.push(lines[i]);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      buffer.push(lines[i]); continue;
    }
    const table = parsedTable(lines, i);
    if (!table) { buffer.push(lines[i]); continue; }
    flush();
    segments.push({ type: 'table', headers: table.headers, rows: table.rows });
    i = table.end - 1;
  }
  flush();
  return segments;
}

function verticalTable({ headers, rows }) {
  const output = [''];
  rows.forEach((row, index) => {
    output.push(`**记录 ${index + 1}**`);
    headers.forEach((header, column) => {
      const label = header.replace(/^\*\*(.*?)\*\*$/, '$1') || `字段 ${column + 1}`;
      output.push(`**${label}**：${row[column] || '—'}`);
    });
    output.push('');
  });
  return output.join('\n');
}

export function cardMarkdownTables(text) {
  return cardMarkdownSegments(text).map((segment) => segment.type === 'table' ? verticalTable(segment) : segment.text).join('\n');
}

const plainHeader = (text, index) => String(text ?? '').replace(/^\*\*(.*?)\*\*$/, '$1').replace(/`/g, '').trim() || `字段 ${index + 1}`;

export function nativeCardTable(segment) {
  if (segment?.type !== 'table' || segment.headers.length > 6 || segment.rows.length > 50) return null;
  const columns = segment.headers.map((header, index) => ({
    name: `column_${index + 1}`,
    display_name: plainHeader(header, index),
    data_type: 'lark_md',
    width: 'auto',
    vertical_align: 'top',
    horizontal_align: 'left',
  }));
  return {
    tag: 'table',
    page_size: Math.max(1, Math.min(10, segment.rows.length)),
    row_height: 'auto',
    freeze_first_column: segment.headers.length > 2,
    header_style: { text_align: 'left', background_style: 'grey', text_color: 'default', bold: true, lines: 2 },
    columns,
    rows: segment.rows.map((row) => Object.fromEntries(columns.map((column, index) => [column.name, row[index] || '—']))),
  };
}

// The IM message-card PATCH route was verified to accept one native table;
// content-product Markdown limits are not the contract for this route.
export function fitNativeCardTables(card, maxTables = 1) {
  let count = 0, changed = false;
  const copy = structuredClone(card);
  const visit = value => {
    if (!value || typeof value !== 'object') return value;
    if (value.tag === 'table') {
      if (count++ < maxTables) return value;
      changed = true;
      return {tag:'markdown',text_size:'normal',content:verticalTable({
        headers:(value.columns ?? []).map(c=>c.display_name ?? c.name),
        rows:(value.rows ?? []).map(row=>(value.columns ?? []).map(c=>{
          const cell=row[c.name];
          return cell === null || cell === undefined ? '—' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
        })),
      })};
    }
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child)) value[key] = child.map(visit);
      else if (child && typeof child === 'object') value[key] = visit(child);
    }
    return value;
  };
  visit(copy);
  return changed ? copy : card;
}
