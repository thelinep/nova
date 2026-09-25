'use strict';
/* ===========================================================================
 * NOVA Runtime — local media store
 *
 * Images, audio and video that you upload or NOVA generates live as files under
 * <DATA_DIR>/media, with a `media` record per file: kind, type, size,
 * SHA-256, source (upload | comfyui) and provenance (prompt, model,
 * settings). File types are detected from the bytes, not the name, and only
 * common image, audio and video formats are accepted. Nothing here touches the
 * network.
 * ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = { image: 25 * 1024 * 1024, audio: 500 * 1024 * 1024, video: 500 * 1024 * 1024 };
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

/** MP4/MOV family: a 'vide' track handler means video; otherwise the brand decides. */
function isoType(b) {
  const brand = b.subarray(8, 12).toString('latin1');
  let hasHandler = false;
  for (let i = b.indexOf('hdlr'); i !== -1 && i + 16 <= b.length; i = b.indexOf('hdlr', i + 4)) {
    hasHandler = true;
    if (b.subarray(i + 12, i + 16).toString('latin1') === 'vide') return brand === 'qt  ' ? { kind: 'video', mime: 'video/quicktime', ext: '.mov' } : { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
  }
  if (hasHandler || AUDIO_BRANDS.has(brand)) return { kind: 'audio', mime: 'audio/mp4', ext: '.m4a' };
  return brand === 'qt  ' ? { kind: 'video', mime: 'video/quicktime', ext: '.mov' } : { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
}

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function mediaDir(dataDir) { return path.join(dataDir, 'media'); }

/** Detects the format from magic bytes. Returns {kind, mime, ext} or null. */
function sniff(buffer) {
  const b = buffer, s = (start, end) => b.subarray(start, end).toString('latin1');
  if (b.length >= 8 && b[0] === 0x89 && s(1, 4) === 'PNG') return { kind: 'image', mime: 'image/png', ext: '.png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: '.webp' };
  if (b.length >= 6 && (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a')) return { kind: 'image', mime: 'image/gif', ext: '.gif' };
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: '.wav' };
  if (b.length >= 3 && s(0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg', ext: '.mp3' };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { kind: 'audio', mime: 'audio/mpeg', ext: '.mp3' };
  if (b.length >= 12 && s(0, 4) === 'FORM' && (s(8, 12) === 'AIFF' || s(8, 12) === 'AIFC')) return { kind: 'audio', mime: 'audio/aiff', ext: '.aiff' };
  if (b.length >= 4 && s(0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: '.ogg' };
  if (b.length >= 4 && s(0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac', ext: '.flac' };
  if (b.length >= 12 && s(4, 8) === 'ftyp') return isoType(b);
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'audio', mime: 'audio/webm', ext: '.webm' };
  return null;
}

function cleanName(name) { return String(name || 'file').replace(/[\\/\0]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || 'file'; }

function saveMedia(store, dataDir, { buffer, originalName, source = 'upload', provenance = null, expectKind = null }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw error('The file is empty.');
  const type = sniff(buffer);
  if (!type) throw error('Unsupported file type. Use PNG, JPEG, WebP or GIF images; WAV, AIFF, MP3, M4A, OGG, FLAC or WebM audio; or MP4 or MOV video.', 415);
  if (expectKind && type.kind !== expectKind) throw error(`Expected ${{ image: 'an image', audio: 'an audio file', video: 'a video' }[expectKind] || expectKind}.`, 415);
  if (buffer.length > LIMITS[type.kind]) throw error(`${{ image: 'Images', audio: 'Audio files', video: 'Videos' }[type.kind]} are limited to ${LIMITS[type.kind] / 1024 / 1024} MB.`, 413);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const id = 'media_' + crypto.randomBytes(8).toString('hex');
  const fileName = id + type.ext;
  fs.mkdirSync(mediaDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(mediaDir(dataDir), fileName), buffer, { flag: 'wx' });
  const record = { id, type: 'media', kind: type.kind, mime: type.mime, bytes: buffer.length, sha256, fileName, originalName: cleanName(originalName), source, provenance, createdAt: new Date().toISOString(), transcript: null, transcription: null };
  store.put('media', record);
  return record;
}

function getMedia(store, id) {
  const record = store.get('media', String(id || ''));
  if (!record) throw error('Unknown media item: ' + id, 404);
  return record;
}

function filePath(dataDir, record) {
  const full = path.join(mediaDir(dataDir), path.basename(record.fileName));
  if (!fs.existsSync(full)) throw error('The media file is missing from disk.', 410);
  return full;
}

/** Base64 image data for Ollama's `images` field. */
function imagesForChat(store, dataDir, ids) {
  return (ids || []).slice(0, 8).map(id => {
    const record = getMedia(store, id);
    if (record.kind !== 'image') throw error(record.originalName + ' is not an image.', 400);
    return fs.readFileSync(filePath(dataDir, record)).toString('base64');
  });
}

function deleteMedia(store, dataDir, id) {
  const record = getMedia(store, id);
  try { fs.rmSync(path.join(mediaDir(dataDir), path.basename(record.fileName)), { force: true }); } catch (_) {}
  store.delete('media', record.id);
  return { deleted: record.id };
}

module.exports = { sniff, saveMedia, getMedia, filePath, imagesForChat, deleteMedia, mediaDir, LIMITS };
