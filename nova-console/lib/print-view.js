'use strict';
/* ===========================================================================
 * Maataa Workstation — print view for saved skill outputs
 *
 * Turns the Markdown a skill saved (shot list, call sheet, treatment, summary)
 * into one self-contained, print-ready HTML page. The person prints it or
 * chooses "Save as PDF" in the print dialog, so no PDF library is needed.
 *
 * Only the small Markdown subset the skills write is supported: # headings,
 * pipe tables, - lists, paragraphs, **bold** and `code`. Everything is
 * HTML-escaped first; the model's text can never add markup or script.
 * ========================================================================= */

const escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(text) {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Splits a pipe-table row into cells; "\|" is a literal bar inside a cell.
function cells(line) {
  const out = []; let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { cur += '|'; i++; }
    else if (body[i] === '|') { out.push(cur.trim()); cur = ''; }
    else cur += body[i];
  }
  out.push(cur.trim());
  return out;
}
const isRow = l => /^\s*\|.*\|\s*$/.test(l);
const isDivider = l => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l);

function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n'), html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (isRow(line) && isDivider(lines[i + 1] || '')) {
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      html.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      html.push('<ul>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ul>');
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+/.test(lines[i]) && !isRow(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) para.push(lines[i++]);
    html.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return html.join('\n');
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.45 -apple-system, "Helvetica Neue", "Noto Sans", "Kohinoor Devanagari", "Noto Sans Devanagari", Arial, sans-serif; color: #111; background: #fff; margin: 0; padding: 24px 32px 48px; }
  main { max-width: 190mm; margin: 0 auto; }
  h1 { font-size: 18pt; margin: 0 0 4px; } h2 { font-size: 13pt; margin: 18px 0 6px; break-after: avoid; } h3, h4 { font-size: 11pt; margin: 14px 0 4px; break-after: avoid; }
  p, ul { margin: 6px 0; } ul { padding-left: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 9.5pt; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; } tr { break-inside: avoid; } thead { display: table-header-group; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.92em; }
  .bar { display: flex; gap: 12px; align-items: center; justify-content: space-between; border-bottom: 1px solid #ccc; padding-bottom: 10px; margin-bottom: 16px; font-size: 10pt; color: #555; }
  .bar button { font: inherit; padding: 6px 14px; border: 1px solid #333; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
  footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 8.5pt; color: #666; }
  @page { size: A4; margin: 14mm; }
  @media print { body { padding: 0; } .bar { display: none; } }
`;

/** One complete HTML document for a saved skill output. `nonce` must match the page's CSP. */
function printPage(output, nonce) {
  const o = output || {}, title = o.title || o.skillName || 'Maataa output';
  const made = [o.skillName, o.model ? `model ${o.model}` : '', o.createdAt ? String(o.createdAt).slice(0, 16).replace('T', ' ') + ' UTC' : ''].filter(Boolean).join(' · ');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>
<div class="bar"><span>To make a PDF, press Print and choose “Save as PDF”.</span><button id="print" type="button">Print / Save as PDF</button></div>
${markdownToHtml(o.markdown)}
<footer>${escapeHtml(made)}${made ? ' · ' : ''}Made with Maataa Workstation. Drafted by a local AI model; check every time, name and address before use.</footer>
</main><script nonce="${escapeHtml(nonce || '')}">document.getElementById('print').addEventListener('click', function () { window.print(); });</script></body></html>`;
}

const cspFor = nonce => `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

module.exports = { markdownToHtml, printPage, cspFor, escapeHtml };
