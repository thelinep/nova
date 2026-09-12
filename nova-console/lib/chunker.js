'use strict';
/* ===========================================================================
 * NOVA Runtime — chunking
 *
 * A real markdown/code-aware splitter, not `text.slice(i, i+500)` on a
 * loop. Two passes: first the document is parsed into typed blocks —
 * fenced code (kept atomic, never split mid-block, never merged across a
 * fence boundary), markdown headings (tracked so every chunk knows which
 * section it came from), and prose paragraphs. Second, blocks are packed
 * into chunks up to a target size, carrying a small character overlap
 * between adjacent prose chunks so a sentence split across a boundary
 * still has context on both sides.
 * ========================================================================= */

const FENCE_RE = /^```/;
const HEADING_RE = /^(#{1,6})\s+(.*)/;

function splitIntoBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let heading = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line.trim())) {
      const fence = [line];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i].trim())) { fence.push(lines[i]); i++; }
      if (i < lines.length) { fence.push(lines[i]); i++; } // consume closing fence
      blocks.push({ type: 'code', heading, text: fence.join('\n') });
      continue;
    }
    const h = line.match(HEADING_RE);
    if (h) {
      heading = h[2].trim();
      blocks.push({ type: 'heading', heading, text: line.trim() });
      i++;
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !FENCE_RE.test(lines[i].trim()) && !HEADING_RE.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push({ type: 'para', heading, text: para.join('\n').trim() });
  }
  return blocks;
}

/** Split one oversized paragraph on sentence boundaries so a single
 *  enormous block of prose still gets bounded chunks instead of one
 *  giant one. Falls back to hard character slicing only as a last
 *  resort (e.g. a paragraph with no sentence punctuation at all). */
function splitLongParagraph(text, maxChars) {
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [text];
  const parts = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > maxChars && buf) { parts.push(buf); buf = s; }
    else buf += s;
  }
  if (buf) parts.push(buf);
  // Last-resort hard slice for a single sentence longer than maxChars.
  return parts.flatMap(p => {
    if (p.length <= maxChars * 1.3) return [p];
    const out = [];
    for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
    return out;
  });
}

/**
 * chunkText(text, opts) -> [{text, heading, isCode}]
 * opts.maxChars   target chunk size (default 1000)
 * opts.overlap    characters of trailing context carried into the next
 *                 prose chunk (default 120)
 */
function chunkText(text, opts) {
  opts = opts || {};
  const maxChars = opts.maxChars || 1000;
  const overlap = Math.min(opts.overlap ?? 120, Math.floor(maxChars / 4));
  const blocks = splitIntoBlocks(text || '');

  const chunks = [];
  let buf = '';
  let bufHeading = null;

  function flush() {
    const trimmed = buf.trim();
    if (trimmed) chunks.push({ text: trimmed, heading: bufHeading, isCode: false });
    buf = '';
  }

  for (const b of blocks) {
    if (b.type === 'heading') { bufHeading = b.heading; continue; } // heading text itself isn't a chunk on its own
    if (b.type === 'code') {
      flush();
      // A code block bigger than the target size is still kept atomic —
      // splitting code mid-statement is worse than one oversized chunk.
      chunks.push({ text: b.text, heading: b.heading, isCode: true });
      continue;
    }
    // prose paragraph
    const pieces = b.text.length > maxChars * 1.4 ? splitLongParagraph(b.text, maxChars) : [b.text];
    for (const piece of pieces) {
      const candidate = buf ? buf + '\n\n' + piece : piece;
      if (candidate.length > maxChars && buf) {
        flush();
        let prevTail = '';
        if (chunks.length && !chunks[chunks.length - 1].isCode) {
          const raw = chunks[chunks.length - 1].text.slice(-overlap);
          const spaceAt = raw.indexOf(' ');
          prevTail = spaceAt >= 0 && spaceAt < raw.length - 1 ? raw.slice(spaceAt + 1) : raw;
        }
        buf = prevTail ? prevTail + '\n\n' + piece : piece;
        bufHeading = b.heading;
      } else {
        buf = candidate;
        bufHeading = b.heading || bufHeading;
      }
    }
  }
  flush();
  return chunks.filter(c => c.text.trim().length > 0);
}

module.exports = { chunkText };
