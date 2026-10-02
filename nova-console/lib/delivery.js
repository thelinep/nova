'use strict';
/* ===========================================================================
 * Delivery: how a character says a line
 *
 * A line is split into segments, each with a delivery (a mood or a mode such
 * as shouting, whispering, taunting or singing). Where it comes from, in order:
 *   1. cues written in the text: "[shout] Get out! [whisper] Come back."
 *      or "(sings) …", "(laughs)", "[pause]"
 *   2. a mood chosen for the whole line (the preview's mood list)
 *   3. the character's personality: a local model acts as voice director and
 *      picks a delivery for each sentence from the personality, the way of
 *      speaking and what the words mean
 *   4. simple signs in the text (!, CAPITALS, …) and the character's default
 *
 * Each delivery changes speed, pitch and loudness and adds an effect (a
 * compressor for shouting, a breathy filter for whispering, vibrato and room
 * for singing). Kokoro and macOS voices cannot really sing or whisper; these
 * are performances of the effect. Voices from VoiceStudio also receive the
 * delivery as a spoken instruction, which expressive engines follow.
 * ========================================================================= */

/** speed ×, pitch in semitones, gain in dB, ffmpeg effect, pause after (s), instruction for expressive engines */
const MOODS = {
  neutral:    { label: 'Neutral',    speed: 1.00, pitch: 0,  gain: 0,   fx: '', pause: 0.25, say: 'in a natural, even tone' },
  calm:       { label: 'Calm',       speed: 0.92, pitch: -1, gain: -2,  fx: 'lowpass=f=9000', pause: 0.4, say: 'calmly and slowly, softly' },
  warm:       { label: 'Warm',       speed: 0.95, pitch: 0,  gain: 0,   fx: 'lowpass=f=8000,bass=g=2', pause: 0.35, say: 'warmly and kindly, like a caring mother' },
  joyful:     { label: 'Joyful',     speed: 1.06, pitch: 2,  gain: 1,   fx: '', pause: 0.25, say: 'joyfully, smiling while speaking' },
  excited:    { label: 'Excited',    speed: 1.12, pitch: 3,  gain: 2,   fx: '', pause: 0.15, say: 'with excitement and energy' },
  sad:        { label: 'Sad',        speed: 0.86, pitch: -2, gain: -3,  fx: 'lowpass=f=7000', pause: 0.5, say: 'sadly, slowly, with a heavy heart' },
  angry:      { label: 'Angry',      speed: 1.06, pitch: -1, gain: 4,   fx: 'acompressor=threshold=-18dB:ratio=4:attack=5:release=60', pause: 0.2, say: 'angrily, sharp and forceful' },
  shouting:   { label: 'Shouting',   speed: 1.04, pitch: 2,  gain: 7,   fx: 'highpass=f=150,acompressor=threshold=-20dB:ratio=6:attack=3:release=50,alimiter=limit=0.95', pause: 0.25, say: 'shouting loudly' },
  whispering: { label: 'Whispering', speed: 0.94, pitch: 0,  gain: -9,  fx: 'highpass=f=400,lowpass=f=6500,aecho=0.6:0.3:12:0.2', pause: 0.35, say: 'in a whisper, breathy and close' },
  taunting:   { label: 'Taunting',   speed: 0.92, pitch: 2,  gain: 1,   fx: 'vibrato=f=4:d=0.18', pause: 0.3, say: 'teasingly, in a mocking, sing-song taunt' },
  fearful:    { label: 'Fearful',    speed: 1.10, pitch: 2,  gain: -1,  fx: 'tremolo=f=7:d=0.35', pause: 0.2, say: 'fearfully, voice trembling' },
  singing:    { label: 'Singing',    speed: 0.84, pitch: 3,  gain: 1,   fx: 'vibrato=f=5.5:d=0.45,aecho=0.8:0.6:70:0.3', pause: 0.3, say: 'singing the words melodically' },
  laughing:   { label: 'Laughing',   speed: 1.08, pitch: 3,  gain: 1,   fx: 'tremolo=f=9:d=0.5', pause: 0.2, say: 'laughing while speaking' },
};
const NAMES = Object.keys(MOODS);
const SYNONYMS = {
  shout: 'shouting', shouts: 'shouting', yell: 'shouting', yells: 'shouting', scream: 'shouting', screams: 'shouting', loud: 'shouting',
  whisper: 'whispering', whispers: 'whispering', softly: 'whispering', quiet: 'whispering',
  sing: 'singing', sings: 'singing', song: 'singing', chant: 'singing', hum: 'singing',
  taunt: 'taunting', taunts: 'taunting', tease: 'taunting', teasing: 'taunting', mock: 'taunting', mocking: 'taunting', sarcastic: 'taunting',
  happy: 'joyful', joy: 'joyful', cheerful: 'joyful', smile: 'joyful', laugh: 'laughing', laughs: 'laughing', giggle: 'laughing',
  angrily: 'angry', furious: 'angry', rage: 'angry', mad: 'angry',
  cry: 'sad', cries: 'sad', crying: 'sad', sob: 'sad', sorrow: 'sad', sigh: 'sad', sighs: 'sad',
  scared: 'fearful', afraid: 'fearful', fear: 'fearful', nervous: 'fearful',
  gentle: 'warm', loving: 'warm', motherly: 'warm', tender: 'warm', kind: 'warm',
  serene: 'calm', peaceful: 'calm', divine: 'calm', relaxed: 'calm',
  excitedly: 'excited', thrilled: 'excited', normal: 'neutral', plain: 'neutral',
};
function moodName(word) { const w = String(word || '').toLowerCase().trim(); return MOODS[w] ? w : SYNONYMS[w] || null; }

/** Splits a line on cues: [shout] … (sings) … [pause]. Returns segments or null when there are none. */
function parseCues(text) {
  const re = /\[(\w+)\]|\((\w+)\)/g;
  const out = []; let last = 0, mood = null, found = false, m;
  while ((m = re.exec(text))) {
    const word = (m[1] || m[2]).toLowerCase();
    const name = word === 'pause' ? 'pause' : moodName(word);
    if (!name) continue;
    found = true;
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ mood: mood || null, text: before });
    if (name === 'pause') out.push({ mood: 'pause', text: '' });
    else mood = name;
    last = m.index + m[0].length;
  }
  if (!found) return null;
  const rest = text.slice(last).trim();
  if (rest) out.push({ mood: mood || null, text: rest });
  return out;
}

function sentences(text) { return (String(text).match(/[^.!?।…]+[.!?।…]*["')\]]*\s*/g) || [String(text)]).map(s => s.trim()).filter(Boolean); }

/** A guess from the words themselves when no director is available. */
function guess(sentence, fallback = 'neutral') {
  const letters = sentence.replace(/[^A-Za-z]/g, '');
  if (letters.length > 6 && letters === letters.toUpperCase()) return 'shouting';
  if (/!{2,}/.test(sentence)) return 'excited';
  if (/!\s*$/.test(sentence)) return fallback === 'neutral' ? 'joyful' : fallback;
  if (/\.\.\.|…/.test(sentence) && fallback === 'neutral') return 'calm';
  return fallback;
}

/** The character's usual delivery, from the default chosen or the words of its personality. */
function baseMood(character) {
  const set = character && character.delivery && moodName(character.delivery.mood);
  if (set && set !== 'neutral') return set;
  const words = `${character?.personality || ''} ${character?.speakingStyle || ''}`.toLowerCase().split(/[^a-z]+/);
  for (const w of words) { const m = moodName(w); if (m && m !== 'neutral') return m; }
  return set || 'neutral';
}

function merge(segments) {
  const out = [];
  for (const s of segments.slice(0, 40)) {
    const prev = out[out.length - 1];
    if (prev && prev.mood === s.mood && s.mood !== 'pause') prev.text += ' ' + s.text; else out.push({ ...s });
  }
  return out.slice(0, 12);
}

/**
 * Plans the delivery of a line. director (optional) is async ({ system, user }) => text
 * from a local model. Returns [{ mood, text }] where mood 'pause' is silence.
 */
async function plan(character, text, { mood = null, director = null } = {}) {
  const line = String(text || '').trim();
  const base = baseMood(character);
  const cued = parseCues(line);
  if (cued) return merge(cued.map(s => ({ mood: s.mood || (mood && moodName(mood)) || base, text: s.text })).filter(s => s.mood === 'pause' || s.text));
  const forced = mood && mood !== 'auto' ? moodName(mood) : null;
  if (forced) return [{ mood: forced, text: line }];
  const auto = !character || !character.delivery || character.delivery.auto !== false;
  if (auto && director && line.length > 0) {
    try {
      const system = [
        'You are a voice director for a text-to-speech actor. Split the line into 1 to 6 parts and choose a delivery for each part.',
        `Deliveries: ${NAMES.join(', ')}, pause.`,
        `The character: ${character?.name || 'the narrator'}${character?.tagline ? ', ' + character.tagline : ''}. Personality: ${character?.personality || 'not given'}. How they speak: ${character?.speakingStyle || 'not given'}. Their usual delivery is "${base}".`,
        'Choose from the meaning of each sentence and the personality: anger is angry or shouting, teasing is taunting, lyrics or verse are singing, secrets are whispering, comfort is warm. Use the usual delivery when nothing calls for a change.',
        'Copy the words exactly, in order, without adding, removing or translating anything. Reply with JSON only: {"parts":[{"delivery":"warm","text":"..."}]}',
      ].join('\n');
      const raw = await director({ system, user: line });
      const json = JSON.parse(String(raw).replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
      const parts = (json.parts || json.segments || []).map(p => ({ mood: p.delivery === 'pause' ? 'pause' : moodName(p.delivery || p.mood) || base, text: String(p.text || '').trim() })).filter(p => p.mood === 'pause' || p.text);
      const squash = s => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
      if (parts.length && squash(parts.map(p => p.text).join(' ')) === squash(line)) return merge(parts);
    } catch (_) { /* fall back to the signs in the text */ }
  }
  return merge(sentences(line).map(s => ({ mood: guess(s, base), text: s })));
}

/** ffmpeg filters for a delivery, plus the character's own pitch, at 44.1 kHz. */
function filters(moodNameValue, characterPitch = 0) {
  const m = MOODS[moodNameValue] || MOODS.neutral;
  const semis = (Number(characterPitch) || 0) + m.pitch;
  const f = ['aresample=44100'];
  if (semis) { const r = Math.pow(2, semis / 12); f.push(`asetrate=44100*${r.toFixed(4)}`, 'aresample=44100', `atempo=${(1 / r).toFixed(4)}`); }
  if (m.fx) f.push(m.fx);
  if (m.gain) f.push(`volume=${m.gain}dB`);
  return f.join(',');
}

module.exports = { MOODS, NAMES, moodName, parseCues, plan, guess, baseMood, filters, sentences };
