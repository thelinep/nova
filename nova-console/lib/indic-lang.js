'use strict';
/* ===========================================================================
 * Maataa Workstation — which Indian language is this text in?
 *
 * Works from the writing system (Unicode blocks), so it needs no model and no
 * network. A script tells you the language only when one language uses it:
 * Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi and Odia do. Devanagari
 * is shared by Hindi, Marathi, Nepali, Sanskrit, Konkani, Maithili, Dogri and
 * Bodo; the Bengali script by Bengali and Assamese; the Arabic script by Urdu,
 * Kashmiri and Sindhi. For those the first guess is the most widely used
 * language, a few marker words refine it, and `candidates` lists the rest, so
 * callers can ask the person instead of pretending to know.
 *
 * Hindi typed in English letters ("kya haal hai") is reported as Hindi with
 * romanized: true.
 * ========================================================================= */

const SCRIPTS = [
  { script: 'Devanagari', from: 0x0900, to: 0x097f, lang: 'hi', candidates: ['hi', 'mr', 'ne', 'sa', 'kok', 'mai', 'doi', 'brx'] },
  { script: 'Bengali', from: 0x0980, to: 0x09ff, lang: 'bn', candidates: ['bn', 'as', 'mni'] },
  { script: 'Gurmukhi', from: 0x0a00, to: 0x0a7f, lang: 'pa', candidates: ['pa'] },
  { script: 'Gujarati', from: 0x0a80, to: 0x0aff, lang: 'gu', candidates: ['gu'] },
  { script: 'Odia', from: 0x0b00, to: 0x0b7f, lang: 'or', candidates: ['or'] },
  { script: 'Tamil', from: 0x0b80, to: 0x0bff, lang: 'ta', candidates: ['ta'] },
  { script: 'Telugu', from: 0x0c00, to: 0x0c7f, lang: 'te', candidates: ['te'] },
  { script: 'Kannada', from: 0x0c80, to: 0x0cff, lang: 'kn', candidates: ['kn'] },
  { script: 'Malayalam', from: 0x0d00, to: 0x0d7f, lang: 'ml', candidates: ['ml'] },
  { script: 'Arabic', from: 0x0600, to: 0x06ff, lang: 'ur', candidates: ['ur', 'ks', 'sd'] },
  { script: 'Ol Chiki', from: 0x1c50, to: 0x1c7f, lang: 'sat', candidates: ['sat'] },
  { script: 'Meetei Mayek', from: 0xabc0, to: 0xabff, lang: 'mni', candidates: ['mni'] },
];

const NAMES = { hi: 'Hindi', mr: 'Marathi', ne: 'Nepali', sa: 'Sanskrit', kok: 'Konkani', mai: 'Maithili', doi: 'Dogri', brx: 'Bodo', bn: 'Bengali', as: 'Assamese', mni: 'Manipuri', pa: 'Punjabi', gu: 'Gujarati', or: 'Odia', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', ur: 'Urdu', ks: 'Kashmiri', sd: 'Sindhi', sat: 'Santali', en: 'English' };

// Words that are common in one language and rare in the others that share its script.
const MARKERS = {
  mr: /(?:^|[\s,.!?।])(?:आहे|आहेत|आणि|नाही|काय|मला|तुम्ही|होते|करा|कोणता|द्या)(?=$|[\s,.!?।])/u,
  ne: /(?:^|[\s,.!?।])(?:छ|छन्|हुन्छ|गर्नुहोस्|तपाईं|मलाई|हो|भयो|र)(?=$|[\s,.!?।])/u,
  sa: /(?:^|[\s,.!?।])(?:अस्ति|सन्ति|भवति|किम्|अहम्|त्वम्|च|एव)(?=$|[\s,.!?।॥])|[ःऽ]|॥/u,
  as: /[ৰৱ]/u,
};
const HINGLISH = /\b(?:hai|hain|nahi|nahin|kya|kyu|kyun|kaise|kaisa|mera|meri|mujhe|aap|tum|hum|karo|karna|kar|raha|rahi|tha|thi|aur|lekin|bahut|accha|theek|thik|kaha|kahan|kab|abhi|bolo|batao|samajh|chahiye|hoga|wala|wali|yeh|woh|iska|uska|namaste|shukriya|dhanyavaad|ki|ka|ko|se|mein)\b/gi;

function detect(text) {
  const s = String(text || '');
  const counts = new Map(); let letters = 0, latin = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) { latin++; letters++; continue; }
    const hit = SCRIPTS.find(x => c >= x.from && c <= x.to);
    if (hit) { counts.set(hit, (counts.get(hit) || 0) + 1); letters++; }
  }
  if (!letters) return { lang: 'en', name: NAMES.en, script: 'Latin', candidates: ['en'], romanized: false, confidence: 0 };
  let best = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  if (!best || latin > bestN * 3) {
    const words = s.toLowerCase().match(/[a-z']+/g) || [], hits = (s.match(HINGLISH) || []).length;
    const romanized = words.length >= 2 && hits >= 2 && hits / words.length >= 0.3;
    return romanized
      ? { lang: 'hi', name: NAMES.hi, script: 'Latin', candidates: ['hi', 'ur', 'en'], romanized: true, confidence: Math.min(0.9, 0.4 + hits / words.length) }
      : { lang: 'en', name: NAMES.en, script: 'Latin', candidates: ['en'], romanized: false, confidence: 0.8 };
  }
  let lang = best.lang, sure = best.candidates.length === 1 ? 0.95 : 0.6;
  if (best.script === 'Devanagari') {
    if (MARKERS.mr.test(s)) { lang = 'mr'; sure = 0.8; } else if (MARKERS.sa.test(s)) { lang = 'sa'; sure = 0.7; } else if (MARKERS.ne.test(s) && !/(?:^|\s)(?:है|हैं|का|की|के|में)(?=$|[\s,.!?।])/u.test(s)) { lang = 'ne'; sure = 0.7; }
  } else if (best.script === 'Bengali' && MARKERS.as.test(s)) { lang = 'as'; sure = 0.85; }
  return { lang, name: NAMES[lang], script: best.script, candidates: [lang, ...best.candidates.filter(c => c !== lang)], romanized: false, confidence: Math.round(sure * (bestN / letters) * 100) / 100 };
}

/** The script a language is normally written in, for checking that a reply came back in it. */
function scriptOf(lang) { const hit = SCRIPTS.find(x => x.candidates.includes(lang)); return hit ? hit.script : 'Latin'; }

module.exports = { detect, scriptOf, NAMES, SCRIPTS };
