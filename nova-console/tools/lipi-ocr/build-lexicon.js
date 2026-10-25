'use strict';
/**
 * Builds lib/lipi-brahmi-lexicon.json: the words the Brahmi report looks for in OCR readings.
 *
 *   node tools/lipi-ocr/build-lexicon.js
 *
 * The vocabulary is Ashokan Prakrit (eastern forms with l for r, western forms with r) and a little
 * Sanskrit, with the spellings the inscriptions use. Forms are written here in Devanagari and turned
 * into Brahmi with lib/lipi-scripts.js. Verb forms point to their Sanskrit dhatu, and the dhatu is
 * looked up in the Paninian Dhatupatha (guru/data/panini/dhatupatha.tsv) for its number and meaning.
 */
const fs = require('node:fs');
const path = require('node:path');
const scripts = require('../../lib/lipi-scripts');

const ROOT = path.join(__dirname, '..', '..');
const DHATUPATHA = path.join(ROOT, '..', 'guru', 'data', 'panini', 'dhatupatha.tsv');

// [forms separated by |, Hindi meaning, English meaning, topic (for anya)]
const LEX = {
  sangya: [
    ['देवानंपिय|देवानंपियेन|देवानंपियो|देवानंपियस|देवानपिय|देवानपियेन', 'देवताओं का प्रिय (अशोक की उपाधि)', 'Beloved of the gods (Ashoka’s title)'],
    ['पियदसि|पियदसिन|पियदसी|प्रियदसि', 'प्रियदर्शी (अशोक का नाम)', 'Piyadasi (Ashoka’s name)'],
    ['असोक|असोकस', 'अशोक', 'Asoka'],
    ['राजा|लाजा|राजिना|लाजिना|राञो|लाजिने', 'राजा', 'king'],
    ['धंम|धम|ध्रंम|धंमं|धंमस|धंमलिपि|धमलिपि', 'धम्म, धर्म', 'dhamma, righteousness'],
    ['जन|जनो|जणो|जणे|जने', 'लोग', 'people'],
    ['मनुस|मनुसा|मनुसानं', 'मनुष्य', 'human beings'],
    ['पान|पाना|प्राण|पानानं', 'प्राणी', 'living beings'],
    ['पुत|पुत्र|पुता|पुतलाभेसु|पुत्रलाभेसु', 'पुत्र', 'son'],
    ['माता|पितु|मातापितु|मातरि', 'माता, पिता', 'mother, father'],
    ['पजा', 'प्रजा', 'subjects, children'],
    ['भगव|भगवं|भगवता', 'भगवान', 'the Blessed One'],
    ['बुध|बुधे|बुधस', 'बुद्ध', 'the Buddha'],
    ['सक्यमुनि|सक्यमुनी|सकमुनि', 'शाक्यमुनि', 'Sakyamuni'],
    ['लिपि|दिपि|लिपी', 'लिपि, लेख', 'writing, edict'],
    ['मंगल|मगल|मंगलं|मगलं', 'मंगल-कर्म, अनुष्ठान', 'ceremony, rite'],
    ['दान|दानं|दाने', 'दान', 'gift'],
    ['वस|वसानि|वसाभिसित|वसाभिसितेन', 'वर्ष (राज्याभिषेक के वर्ष)', 'year (of reign)'],
    ['अतन|अतना', 'स्वयं', 'himself, in person'],
    ['उबलिक|उबलिके', 'कर-मुक्त', 'free of tax'],
    ['अठभागिय|अठभागिये', 'आठवाँ भाग (कर)', 'one-eighth share (tax)'],
    // Sanskrit and Old Malay of the Kushan, Gupta, Pallava and Southeast Asian inscriptions
    ['महाराज|महाराजस्य|महाराजाधिराज|महाराजाधिराजस्य|राज्ञः', 'महाराज, महाराजाधिराज', 'great king, king of kings'],
    ['कनिष्क|कनिष्कस्य|कणिष्कस्य|हुविष्क|हुविष्कस्य|वासुदेव', 'कनिष्क, हुविष्क, वासुदेव (कुषाण राजा)', 'Kanishka, Huvishka, Vasudeva (Kushan kings)'],
    ['देवपुत्र|देवपुत्रस्य', 'देवपुत्र (कुषाण उपाधि)', 'son of the gods (Kushan title)'],
    ['समुद्रगुप्त|चन्द्रगुप्त|कुमारगुप्त|स्कन्दगुप्त|गुप्त|गुप्तस्य', 'गुप्त राजा', 'Gupta kings'],
    ['मूलवर्म|मूलवर्मा|मूलवर्मणः|पूर्णवर्म|पूर्णवर्मणः|कुण्डुङ्ग|अश्ववर्म', 'मूलवर्मा, पूर्णवर्मा (इंडोनेशिया के राजा)', 'Mulavarman, Purnavarman (kings in Indonesia)'],
    ['यूप|यूपो|यूपोयं', 'यूप (यज्ञ-स्तंभ)', 'sacrificial post'],
    ['बोधिसत्व|बोधिसत्त्व|भिक्षु|भिक्षुस्य', 'बोधिसत्त्व, भिक्षु', 'Bodhisattva, monk'],
    ['स्वस्ति|सिद्धम्|सिद्धम|श्री|श्रीमत्', 'स्वस्ति, सिद्धम्, श्री (मंगल-शब्द)', 'svasti, siddham, śrī (auspicious openings)'],
    ['दातु|कदातुआन|वनुआ|हुलुन', 'दातु, राज्य, देश, प्रजा (प्राचीन मलय)', 'ruler, kingdom, country, subjects (Old Malay)'],
  ],
  sarvanaam: [
    ['अयं|इयं|इयम|इमं|इमे|इमाय|इमस', 'यह, ये', 'this, these'],
    ['एतं|एतस|एतेन|एताय|एतिय|एते|एतरिस|एतरिसा', 'यह, ऐसा', 'this, such'],
    ['तस|तेन|ताय|तानि|तेसं', 'वह, उसके', 'that, his'],
    ['ममया|मम|मया', 'मेरा, मेरे द्वारा', 'my, by me'],
    ['हकं|अहं', 'मैं', 'I'],
    ['अञ|अञं|अञे|अञमञ', 'अन्य, दूसरा', 'other'],
    ['सव|सवे|सवत|सवता|सवेसु|सवस', 'सब, सर्वत्र', 'all, everywhere'],
    ['यथा|तथा|यत|यं|यो|ये', 'जैसे, जो', 'as, which, who'],
    ['किंति|किति|कोचि|किचि', 'कोई, क्या', 'some, what'],
  ],
  sankhya: [
    ['एक|एके|एकं|एकतिया', 'एक', 'one'],
    ['दुवे|दुवि|दुतिय', 'दो, दूसरा', 'two, second'],
    ['तिनि|तीनि|ततिय|तिनि', 'तीन, तीसरा', 'three, third'],
    ['चतु|चतुर|चतालि|चतुरं', 'चार', 'four'],
    ['पंच|पच|पंचसु|पंचमं', 'पाँच', 'five'],
    ['छ|सड|सडु', 'छह', 'six'],
    ['सत|सपत', 'सात / सौ', 'seven / a hundred'],
    ['अठ|अठम|अठवसा', 'आठ, आठवाँ', 'eight, eighth'],
    ['नव', 'नौ', 'nine'],
    ['दस|दसवस|दसवसाभिसित', 'दस', 'ten'],
    ['दुवाडस|दुवादस|बादस', 'बारह', 'twelve'],
    ['तेडस|तेदस|त्रैदस', 'तेरह', 'thirteen'],
    ['वीसति|वीसतिवस|वीसतिवसाभिसितेन', 'बीस', 'twenty'],
    ['छवीसति|सडुवीसति', 'छब्बीस', 'twenty-six'],
    ['सहस|सहसानि|सतसहस|सतसहसानि', 'हज़ार, लाख', 'thousand, hundred thousand'],
    ['पठम|पठमं|प्रथम', 'पहला', 'first'],
    ['दियढ|दियढिय', 'डेढ़', 'one and a half'],
    ['संवत्सर|संवत्सरे|सं|शकवर्ष|शकवर्षातीत|वर्ष', 'संवत्सर, शक वर्ष', 'year, Saka year (era dates)'],
    ['शत|सहस्र|सहस्राणि|विंशति|त्रिंशत्|प्रथम|द्वितीय|तृतीय', 'सौ, हज़ार, बीस, तीस, पहला, दूसरा, तीसरा', 'hundred, thousand, twenty, thirty, first, second, third'],
  ],
  jyamiti: [
    ['योजन|योजनानि|योजनसतेसु', 'योजन (दूरी की माप)', 'yojana (measure of distance)'],
    ['कोस|कोसिक|अढकोसिक|अढकोसिक्यानि', 'कोस, आधा कोस', 'kos, half a kos (distance)'],
    ['अढ|अढिय', 'आधा', 'half'],
    ['मंडल|मडल', 'मंडल, वृत्त', 'circle, region'],
    ['चतुरस|चतुरंस', 'चौकोर', 'square'],
    ['दीघ|दीघं', 'लंबा', 'long'],
    ['थंभ|थभ|सिलाथभ|सिलाथभे|थंभानि', 'स्तंभ (खड़ा बेलन)', 'pillar (upright column)'],
    ['भाग|भागिय', 'भाग, हिस्सा', 'part, share'],
  ],
  antariksh: [
    ['सुरिय|सूलिय|सुलिय|सूरिय', 'सूर्य', 'sun'],
    ['चंदम|चंदमसूलिय|चंदमसुरिय|चद', 'चंद्रमा', 'moon'],
    ['नखत|नखतेन|नक्खत', 'नक्षत्र', 'lunar mansion, star'],
    ['तिस|तिसेन|तिसाय', 'तिष्य नक्षत्र', 'Tishya (a nakshatra)'],
    ['पुनावसु|पुनावसुने', 'पुनर्वसु नक्षत्र', 'Punarvasu (a nakshatra)'],
    ['चातुंमासी|चातुमासि|चातुंमासिसु', 'चातुर्मास (ऋतु)', 'the four-month season'],
    ['दिविय|दिव्य|दिवियानि|दिव्यानि', 'दिव्य, आकाशीय', 'heavenly'],
    ['विमान|विमानदसना|विमानदसणा', 'विमान (आकाशीय रथ)', 'celestial chariots'],
    ['अगिकंध|अगिखंध|अगिकंधानि', 'अग्नि-स्कंध (आकाश में अग्नि-पुंज)', 'masses of fire (heavenly display)'],
    ['स्वग|स्वगं|सग|सगं|स्वगस', 'स्वर्ग', 'heaven'],
    ['सूर्य|आदित्य|चन्द्र|चन्द्रमस्|नक्षत्र|ग्रह|शुक्ल|कृष्ण|पक्ष', 'सूर्य, चंद्र, नक्षत्र, ग्रह, पक्ष', 'sun, moon, nakshatra, planet, lunar fortnight'],
  ],
  anya: [
    ['दया|दयाय', 'दया', 'compassion', 'dharma'],
    ['सच|सचे|सचं', 'सत्य', 'truth', 'dharma'],
    ['सोचय|सोचये', 'शुद्धता', 'purity', 'dharma'],
    ['संयम|सयम|सयमे', 'संयम', 'self-restraint', 'dharma'],
    ['अविहिसा|अविहिंसा|अनालंभो|अनारंभो', 'अहिंसा', 'non-violence', 'dharma'],
    ['सुसूसा|सुस्रुसा', 'सेवा, आज्ञापालन', 'obedience, service', 'dharma'],
    ['महामात|महामाता|महामात्र', 'महामात्र (अधिकारी)', 'high officials', 'administration'],
    ['राजुक|लजुक|लजूक', 'रज्जुक (अधिकारी)', 'rajuka officers', 'administration'],
    ['युत|युता', 'युक्त (अधिकारी)', 'yuta officers', 'administration'],
    ['पटिवेदक|पटिवेदना', 'प्रतिवेदक (सूचना देने वाले)', 'reporters', 'administration'],
    ['मिग|मिगे|मजूर|मजुला|मोर', 'हिरण, मोर', 'deer, peacock', 'animals'],
    ['हथि|हथी|हस्ति', 'हाथी', 'elephant', 'animals'],
    ['पसु|पसू|पसुओपगानि', 'पशु', 'animals, cattle', 'animals'],
    ['ओसध|ओसधानि|ओसढानि|चिकिसा|चिकीछ', 'औषधि, चिकित्सा', 'medicinal herbs, medical care', 'medicine'],
    ['लुख|लुखानि|वड|अंब|अंबावडिक्य|मूल|फल|फलानि', 'वृक्ष, बरगद, आम, मूल, फल', 'trees, banyan, mango, roots, fruit', 'plants'],
    ['उदुपान|उदुपानानि|कूप', 'कुएँ', 'wells', 'buildings'],
    ['सिला|सिलाय', 'शिला', 'rock, stone', 'buildings'],
    ['तोरण|तोरणो|वेदिका', 'तोरण, वेदिका', 'gateway, railing', 'buildings'],
    ['गुहा|कुभा|लेण', 'गुफा', 'cave', 'buildings'],
    ['बाभन|बम्हण|ब्राह्मण|बमण', 'ब्राह्मण', 'brahmins', 'people'],
    ['समण|स्रमण|श्रमण', 'श्रमण', 'ascetics', 'people'],
    ['संघ|सघ|संघे', 'संघ', 'the Sangha', 'people'],
    ['भिखु|भिखुनि|भिखुनी', 'भिक्षु, भिक्षुणी', 'monks, nuns', 'people'],
    ['योन|योना|कंबोज|गंधार', 'यवन, कंबोज, गांधार', 'Greeks, Kambojas, Gandharans', 'people'],
    ['दास|भटक|दासभटक', 'दास, सेवक', 'slaves, servants', 'people'],
    ['लुंमिनिगाम|लुमिनिगाम|गाम|गामे', 'लुम्बिनी ग्राम, गाँव', 'Lumbini village, village', 'places'],
    ['कलिंग|कलिग|तोसलि|उजेनि|पाटलिपुत|जंबुदीप|जंबुदीपसि', 'कलिंग, तोसली, उज्जैनी, पाटलिपुत्र, जम्बुद्वीप', 'Kalinga, Tosali, Ujjeni, Pataliputra, Jambudvipa', 'places'],
    ['विष्णु|विष्णोः|शिव|लिङ्ग|लिंग|गोमती|तारुम', 'विष्णु, शिव, लिंग, गोमती नदी, तारुमा', 'Vishnu, Shiva, lingam, Gomati river, Taruma', 'religion'],
  ],
  // verb forms → Sanskrit dhatu (SLP1 as in the Dhatupatha, without svara marks)
  dhatu: [
    ['आह|आहा|हेवं आहा', 'brUY', 'कहा', 'said (Panini 3.4.84 replaces brū with āha)'],
    ['लिखापित|लिखापिता|लिखापितं|लेखापेसामि|लेखापिता|लिखित', 'liKa', 'लिखवाया', 'caused to be written'],
    ['कालापित|कारापित|कट|कटे|कतं|कलेति|करोति|करोते|कलोति|कटविय|कतविय', 'qukfY', 'किया, करवाया', 'did, caused to be made'],
    ['उसपापिते|उसपापित|उस्पापित', 'SriY', 'खड़ा करवाया (उत् + श्रि)', 'caused to be raised (ut + śri)'],
    ['जाते|जात|जातो', 'janI', 'उत्पन्न हुआ', 'was born'],
    ['आगाच|आगच|आगछ|आगम|गछेयु|गछति', 'gamx', 'आया, जाता है', 'came, goes'],
    ['महीयिते|महीयित|महियिते', 'maha', 'पूजा की', 'worshipped'],
    ['अभिसित|अभिसितेन|अभिसितस', 'zica', 'अभिषिक्त (अभि + सिच्)', 'consecrated (abhi + sic)'],
    ['वढति|वढिसति|वढि|वढिया', 'vfDu', 'बढ़ता है', 'grows'],
    ['पवतति|पवतिसति|पवतितु', 'vftu', 'प्रवृत्त होता है', 'proceeds'],
    ['दिसति|देखति|दखति|देखिये', 'dfSir', 'देखता है', 'sees'],
    ['सुनेयु|सुणेयु|सुनातु|सुसूसा', 'Sru', 'सुने', 'should hear'],
    ['पालयति|पालन|पालनं', 'pAla', 'रक्षा करता है', 'protects'],
    ['अनुसासति|अनुसासनं|सासन|सासने', 'SAsu@anuSizwO', 'अनुशासन करता है', 'instructs'],
    ['विजित|विजय|विजयमते|विजितसि', 'ji', 'जीता हुआ', 'conquered'],
    ['आलभित|आरभित|आलभितु|आरभितु|आलभियंति', 'raBa', 'वध करना (आ + रभ्)', 'to slaughter (ā + rabh)'],
    ['पजोहितविय|पजोहितव्य|पजोहितविये', 'hu', 'आहुति देनी चाहिए (प्र + हु)', 'should be sacrificed (pra + hu)'],
    ['देति|ददाति|दिंना|दिना|दिंने', 'qudAY', 'देता है, दिया', 'gives, was given'],
    ['वसति|वसेयु|वसंति', 'vasa', 'रहता है', 'lives'],
    ['चलति|चलेयु|चरति|चलितु', 'cara', 'आचरण करता है', 'acts, lives by'],
    ['निखमथ|निखमितु|निकमतु|पकमे|पकमितु', 'kramu', 'निकलना, उद्यम करना', 'to go forth, to strive'],
    ['पसवति|पसवे', 'zUN', 'उत्पन्न करता है (पुण्य)', 'produces (merit)'],
    ['इछति|इछा|इछामि|इछितविये', 'izu', 'चाहता है', 'wishes'],
    ['मंञति|मनति|मञति', 'mana', 'मानता है', 'thinks'],
    ['लभति|लभेयु|लाभ|लाभेसु', 'qulaBaz', 'पाता है, लाभ', 'obtains, gain'],
  ],
};

const brahmi = deva => scripts.fromDeva(deva, 'Brah').text.replace(/\s+/g, '');
const stripSvara = s => s.replace(/[\\^/~]/g, '');

function loadDhatupatha() {
  const out = {};
  if (!fs.existsSync(DHATUPATHA)) return out;
  for (const row of fs.readFileSync(DHATUPATHA, 'utf8').split('\n').slice(1)) {
    const [code, root, artha] = row.split('\t');
    if (!code || !root) continue;
    const k = stripSvara(root);
    (out[k] = out[k] || []).push({ code, root, artha: (artha || '').trim() });
  }
  return out;
}

// SLP1 → Devanagari (for the dhatu and its meaning), by way of Brahmi
const SLP_V = 'aAiIuUfFxXeEoO', SLP_C = 'kKgGNcCjJYwWqQRtTdDnpPbBmyrlvSzsh';
const SIGNS = { A: 0x11038, i: 0x1103A, I: 0x1103B, u: 0x1103C, U: 0x1103D, f: 0x1103E, F: 0x1103F, x: 0x11040, X: 0x11041, e: 0x11042, E: 0x11043, o: 0x11044, O: 0x11045 };
function slp1ToDeva(s) {
  let out = '', prevC = false;
  for (const ch of s) {
    if (SLP_C.includes(ch)) { if (prevC) out += '\u{11046}'; out += String.fromCodePoint(0x11013 + SLP_C.indexOf(ch)); prevC = true; }
    else if (SLP_V.includes(ch)) { out += prevC ? (ch === 'a' ? '' : String.fromCodePoint(SIGNS[ch])) : String.fromCodePoint(0x11005 + SLP_V.indexOf(ch)); prevC = false; }
    else if (ch === 'M') { out += '\u{11001}'; prevC = false; }
    else if (ch === 'H') { out += '\u{11002}'; prevC = false; }
    else { if (prevC) out += '\u{11046}'; prevC = false; out += ch === "'" ? 'ऽ' : ch; }
  }
  if (prevC) out += '\u{11046}';
  return scripts.toDeva(out, 'Brah');
}

function build() {
  const dp = loadDhatupatha();
  const entries = [];
  const missing = [];
  for (const [cat, rows] of Object.entries(LEX)) {
    for (const row of rows) {
      const forms = [...new Set(row[0].split('|').map(f => f.trim()).filter(Boolean))];
      const e = { cat, head: forms[0], forms: forms.map(f => ({ deva: f, brahmi: brahmi(f) })) };
      if (cat === 'dhatu') {
        const [, spec, hi, en] = row;
        const [slp, want] = spec.split('@');   // root@meaning picks one root among homonyms
        const d = (dp[slp] || []).find(x => !want || x.artha.includes(want));
        if (!d) missing.push(slp);
        e.hi = hi; e.en = en;
        e.dhatu = { slp1: slp, deva: slp1ToDeva(slp), code: d ? d.code : null, artha: d ? slp1ToDeva(d.artha) : null };
      } else {
        e.hi = row[1]; e.en = row[2];
        if (row[3]) e.topic = row[3];
      }
      entries.push(e);
    }
  }
  return { entries, missing };
}

if (require.main === module) {
  const { entries, missing } = build();
  if (missing.length) { console.error('Dhatus not found in the Dhatupatha:', missing.join(', ')); process.exitCode = 1; }
  const out = {
    about: 'Ashokan Prakrit and Sanskrit words the Brahmi report looks for. Verb forms point to their dhatu in the Paninian Dhatupatha (Vidyut / ashtadhyayi.com data, MIT).',
    categories: { akshar: 'अक्षर', dhatu: 'धातु', sanyukta: 'संयुक्त अक्षर', sangya: 'संज्ञा', sarvanaam: 'सर्वनाम', sankhya: 'संख्या', jyamiti: 'ज्यामिति और माप', antariksh: 'अंतरिक्ष', anya: 'अन्य विषय' },
    topics: { dharma: 'धम्म और नीति', administration: 'प्रशासन', animals: 'जीव-जंतु', medicine: 'चिकित्सा', plants: 'वनस्पति', buildings: 'निर्माण', people: 'लोग और समुदाय', places: 'स्थान', religion: 'धर्म और देवता' },
    entries,
  };
  fs.writeFileSync(path.join(ROOT, 'lib', 'lipi-brahmi-lexicon.json'), JSON.stringify(out, null, 1));
  console.log(entries.length, 'entries,', entries.reduce((n, e) => n + e.forms.length, 0), 'forms');
}

module.exports = { build, slp1ToDeva };
