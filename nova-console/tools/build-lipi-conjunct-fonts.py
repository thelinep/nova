#!/usr/bin/env python3
"""Build the Maataa Lipi conjunct fonts: Noto fonts plus stacked conjuncts.

First and main case, "Maataa Lipi Brahmi" (Noto Sans Brahmi plus stacked conjuncts):

Unicode Brahmi forms a conjunct when the virama U+11046 stands between two
consonants (the second letter is written below the first), and shows a visible
virama only at the end of a syllable or when ZWNJ follows the virama. Noto Sans
Brahmi 2.004 has no conjunct shaping: every virama is drawn as a bar, so धर्म
shows as ध र्‌ म instead of ध + र-over-म. This script adds what is missing:

  * a reduced, subjoined copy of every consonant (scale 0.62, hung below the line)
  * a GSUB ligature  virama + consonant -> subjoined consonant
  * GPOS mark-to-base and mark-to-mark anchors so the subjoined letter sits
    centred under its base, and a third letter under the second
  * a deeper line descent so stacked letters are not clipped

The source font is OFL-1.1; "Noto" is a Reserved Font Name, so the modified font
is renamed. The licence travels with the font (public/fonts/lipi/OFL-LICENSE.txt).

The same treatment is applied, as an option per script, where a Noto font forms only some
conjuncts (see CONFIG). Scripts that by convention show a visible virama (Takri, Dogra,
Khudawadi) are left alone.

Run:  python3 tools/build-lipi-conjunct-fonts.py <folder with the Noto *-Regular.ttf files>
Writes public/fonts/lipi/maataa-lipi-<script>.woff2
"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

ROOT = os.path.join(os.path.dirname(__file__), '..')
# Size of a subjoined letter and the space between a letter and the one below it. 0.75 / 0 lets the
# lower letter touch the foot of the upper one, as in inscriptions; override to compare (LIPI_SUB_SCALE, LIPI_SUB_GAP).
SCALE, GAP = float(os.environ.get('LIPI_SUB_SCALE', 0.75)), float(os.environ.get('LIPI_SUB_GAP', 0))
SIDE = 0          # extra clear space beyond the letter's own side bearings
EDGE_MIN, EDGE_MAX = 30, 140  # a flat stroke end this wide (font units) counts as an edge
EDGE_BAND = 40     # how close to the top or bottom of a letter an edge must be
SCRIPTS = json.load(open(os.path.join(ROOT, 'lib', 'lipi-scripts.json'), encoding='utf-8'))['scripts']
CONFIG = {  # code: (Noto source file, family name, output slug)
    'Brah': ('NotoSansBrahmi-Regular.ttf', 'Maataa Lipi Brahmi', 'brahmi'),
    'Shrd': ('NotoSansSharada-Regular.ttf', 'Maataa Lipi Sharada', 'sharada'),
    'Diak': ('NotoSerifDivesAkuru-Regular.ttf', 'Maataa Lipi Dives Akuru', 'dives-akuru'),
}
DEVA_CONSONANTS = [chr(c) for c in range(0x0915, 0x093A)] + ['ळ']


def graft(dst, src):
    """Append src's lookups and features to dst and enable them for every script and language."""
    base = len(dst.LookupList.Lookup)
    # contextual lookups name other lookups by index: renumber those references too
    for lk in src.LookupList.Lookup:
        for st in lk.SubTable:
            st = getattr(st, 'ExtSubTable', st)
            for attr in ('PosLookupRecord', 'SubstLookupRecord'):
                for rec in getattr(st, attr, None) or []:
                    rec.LookupListIndex += base
            for rs_attr in ('ChainPosRuleSet', 'ChainPosClassSet', 'PosRuleSet', 'PosClassSet', 'ChainSubRuleSet', 'ChainSubClassSet', 'SubRuleSet', 'SubClassSet'):
                for rs in getattr(st, rs_attr, None) or []:
                    if rs is None:
                        continue
                    for rule in (getattr(rs, 'ChainPosRule', None) or getattr(rs, 'ChainPosClassRule', None) or getattr(rs, 'PosRule', None) or getattr(rs, 'PosClassRule', None)
                                 or getattr(rs, 'ChainSubRule', None) or getattr(rs, 'ChainSubClassRule', None) or getattr(rs, 'SubRule', None) or getattr(rs, 'SubClassRule', None) or []):
                        for attr in ('PosLookupRecord', 'SubstLookupRecord'):
                            for rec in getattr(rule, attr, None) or []:
                                rec.LookupListIndex += base
    dst.LookupList.Lookup.extend(src.LookupList.Lookup)
    dst.LookupList.LookupCount = len(dst.LookupList.Lookup)
    added = []
    existing = {}
    for fr in dst.FeatureList.FeatureRecord:
        existing.setdefault(fr.FeatureTag, []).append(fr)
    for fr in src.FeatureList.FeatureRecord:
        idx = [i + base for i in fr.Feature.LookupListIndex]
        if fr.FeatureTag in existing:
            # shapers use the first record of a tag, so extend the font's own records instead of adding a second
            for old in existing[fr.FeatureTag]:
                old.Feature.LookupListIndex = sorted(set(list(old.Feature.LookupListIndex) + idx))
                old.Feature.LookupCount = len(old.Feature.LookupListIndex)
            continue
        fr.Feature.LookupListIndex = idx
        fr.Feature.LookupCount = len(idx)
        dst.FeatureList.FeatureRecord.append(fr)
        existing[fr.FeatureTag] = [fr]
        added.append(len(dst.FeatureList.FeatureRecord) - 1)
    dst.FeatureList.FeatureCount = len(dst.FeatureList.FeatureRecord)
    for sr in dst.ScriptList.ScriptRecord:
        systems = [sr.Script.DefaultLangSys] + [l.LangSys for l in sr.Script.LangSysRecord]
        for ls in systems:
            if ls is None:
                continue
            ls.FeatureIndex = list(ls.FeatureIndex) + added
            ls.FeatureCount = len(ls.FeatureIndex)


def build(code, src, out, family):
    f = TTFont(src)
    cmap = f.getBestCmap()
    gs = f.getGlyphSet()
    glyf, hmtx = f['glyf'], f['hmtx']
    smap = SCRIPTS[code]['map']
    virama = cmap[ord(smap['्'])]
    consonants = []
    for d in DEVA_CONSONANTS:
        t = smap.get(d)
        if t and len(t) == 1 and ord(t) in cmap and cmap[ord(t)] not in consonants:
            consonants.append(cmap[ord(t)])
    below_glyphs = {cmap[ord(smap[v])] for v in 'ुूृॄ' if len(smap.get(v, '')) == 1 and ord(smap[v]) in cmap}
    u_sign = cmap.get(ord(smap['ु'])) if len(smap.get('ु', '')) == 1 else None

    def rec_is_above(st, c):  # a mark class whose base anchors sit high is an above-base class
        ys = [r.BaseAnchor[c].YCoordinate for r in st.BaseArray.BaseRecord if r.BaseAnchor and len(r.BaseAnchor) > c and r.BaseAnchor[c] is not None]
        return bool(ys) and sorted(ys)[len(ys) // 2] > 300
    # Noto's ccmp already fuses some clusters (क्ष, स्व, a consonant + u / uu ...) before conjuncts form;
    # those fused glyphs get subjoined forms too, so virama + fused glyph still stacks.
    base_set = set(consonants)
    for lk in f['GSUB'].table.LookupList.Lookup:
        if lk.LookupType != 4:
            continue
        for st in lk.SubTable:
            for first, ligs in st.ligatures.items():
                if first in base_set:
                    for lg in ligs:
                        if lg.LigGlyph not in consonants:
                            consonants.append(lg.LigGlyph)

    below_marks, foot = {}, {}
    gpos = f['GPOS'].table if 'GPOS' in f else None
    for lk in (gpos.LookupList.Lookup if gpos else []):
        if lk.LookupType != 4:
            continue
        for st in lk.SubTable:
            # the class the u-sign attaches with (r / rr signs may use another class; they keep their place)
            cls = [rec.Class for gname, rec in zip(st.MarkCoverage.glyphs, st.MarkArray.MarkRecord) if gname == u_sign]
            if not cls or rec_is_above(st, cls[0]):
                continue
            c0 = cls[0]
            for gname, rec in zip(st.MarkCoverage.glyphs, st.MarkArray.MarkRecord):
                if rec.Class == c0:
                    below_marks[gname] = (rec.MarkAnchor.XCoordinate, rec.MarkAnchor.YCoordinate)
            for gname, rec in zip(st.BaseCoverage.glyphs, st.BaseArray.BaseRecord):
                a = rec.BaseAnchor[c0] if rec.BaseAnchor and len(rec.BaseAnchor) > c0 else None
                if a is not None and gname not in foot:
                    foot[gname] = (a.XCoordinate, a.YCoordinate)
    # Magnetic placement by stroke ends ("edges"). An edge is a flat stroke end on the outline: at the
    # bottom of a letter (a foot, where a lower letter can hang) or at the top (where it can be hung).
    #   no edge        -> the middle of the letter
    #   one edge       -> that edge
    #   two or more    -> the right-most edge
    def edges(g, where):
        coords, ends, flags = glyf[g].getCoordinates(glyf)
        pts, fl = list(coords), list(flags)
        ys = [y for _, y in pts]
        found, start = [], 0
        for e in ends:
            c = list(range(start, e + 1)); start = e + 1
            for k in range(len(c)):
                i, j = c[k], c[(k + 1) % len(c)]
                (xa, ya), (xb, yb) = pts[i], pts[j]
                flat = (fl[i] & 1) and (fl[j] & 1) and abs(ya - yb) <= 2 and EDGE_MIN <= abs(xb - xa) <= EDGE_MAX
                if not flat:
                    continue
                if where == 'bottom' and ya <= max(min(ys), 0) + EDGE_BAND:
                    found.append((xa + xb) / 2)
                if where == 'top' and ya >= max(ys) - EDGE_BAND:
                    found.append((xa + xb) / 2)
        return sorted(found)

    def snap(g, where, x0, x1):
        e = edges(g, where)
        if not e:
            return (x0 + x1) / 2, 'middle'
        return max(e), ('edge' if len(e) == 1 else 'right edge')

    subs, geo, sub_foot, rule_count = {}, {}, {}, {}
    for g in consonants:
        bp = BoundsPen(gs); gs[g].draw(bp)
        x0, y0, x1, y1 = bp.bounds
        top = y1 * SCALE
        fx, why_b = snap(g, 'bottom', x0, x1)   # where a lower letter hangs from this letter
        tx, why_t = snap(g, 'top', x0, x1)      # where this letter, reduced, is hung from
        rule_count[why_b] = rule_count.get(why_b, 0) + 1
        pen = TTGlyphPen(gs)
        # the hanging point of the reduced letter at x = 0, its top edge at y = -GAP
        gs[g].draw(TransformPen(pen, (SCALE, 0, 0, SCALE, -tx * SCALE, -GAP - top)))
        name = g + '.sub'
        glyf[name] = pen.glyph()
        hmtx[name] = (0, 0)
        subs[g] = name
        sh = (y1 - y0) * SCALE
        geo[g] = dict(fx=fx, foot_y=min(0, y0), adv=hmtx[g][0])
        geo[name] = dict(fx=(fx - tx) * SCALE, bottom=-GAP - sh, reach_l=(tx - x0) * SCALE, reach_r=(x1 - tx) * SCALE)
        if g in foot:  # where u / uu attach, moved with the reduced letter
            ux, uy = foot[g]
            sub_foot[name] = ((ux - tx) * SCALE, uy * SCALE - GAP - top)

    f.getReverseGlyphMap(rebuild=True)
    # GDEF: subjoined letters are marks
    gdef = f['GDEF'].table
    classdefs = gdef.GlyphClassDef.classDefs
    for s in subs.values():
        classdefs[s] = 3

    lig = '\n'.join(f'    sub {virama} {g} by {s};' for g, s in subs.items())
    bases = '\n'.join(f"    pos base {g} <anchor {round(geo[g]['fx'])} {round(geo[g]['foot_y'])}> mark @SUBJ;" for g in subs)
    def mark1(s):  # a third letter hangs from the second by the same edge rule
        extra = f' <anchor {round(sub_foot[s][0])} {round(sub_foot[s][1])}> mark @BELOWV' if s in sub_foot and below_marks else ''
        return f"    pos mark {s} <anchor {round(geo[s]['fx'])} {round(geo[s]['bottom'])}> mark @SUBJ{extra};"
    marks = '\n'.join(mark1(s) for s in subs.values())
    belowv = '\n'.join(f'markClass {g} <anchor {x} {y}> @BELOWV;' for g, (x, y) in below_marks.items())

    # A lower letter that reaches past the box of the letter above would touch the neighbouring
    # letters. Give that pair room (pair positioning on upper + lower letter): shift the upper letter
    # right by the left overhang and widen it by both overhangs. Letters are grouped in 40-unit steps
    # (room rounded down, reach rounded up) to keep the rules few.
    STEP = 40
    import math
    base_groups, sub_groups = {}, {}
    for g in subs:
        G = geo[g]
        base_groups.setdefault((int(G['fx'] // STEP), int((G['adv'] - G['fx']) // STEP)), []).append(g)
    for sname in subs.values():
        S_ = geo[sname]
        sub_groups.setdefault((math.ceil(S_['reach_l'] / STEP), math.ceil(S_['reach_r'] / STEP)), []).append(sname)
    widen = []
    for (bl_, br_), bl in sorted(base_groups.items()):
        for (sl_, sr_), sl in sorted(sub_groups.items()):
            over_l = max(0, (sl_ - bl_) * STEP + SIDE)
            over_r = max(0, (sr_ - br_) * STEP + SIDE)
            if over_l or over_r:
                widen.append(f"    pos [{' '.join(bl)}] [{' '.join(sl)}] <{round(over_l)} 0 {round(over_l + over_r)} 0>;")
    widen_fea = ('feature dist {\n  lookup SubjoinRoom {\n' + '\n'.join(widen) + '\n  } SubjoinRoom;\n} dist;') if widen else ''
    print(f'  {code} placement of lower letters:', ', '.join(f'{k} {v}' for k, v in sorted(rule_count.items())))
    fea = f"""
languagesystem DFLT dflt;
markClass [{' '.join(subs.values())}] <anchor 0 0> @SUBJ;
{belowv}
lookup LipiConjunct {{
{lig}
}} LipiConjunct;
feature blwf {{ lookup LipiConjunct; }} blwf;
feature cjct {{ lookup LipiConjunct; }} cjct;
feature blwm {{
  lookup SubjoinBase {{
{bases}
  }} SubjoinBase;
}} blwm;
{widen_fea}
feature mkmk {{
  lookup SubjoinStack {{
{marks}
  }} SubjoinStack;
}} mkmk;
"""
    # feaLib writes whole tables, so build the new lookups in a scratch copy and graft them
    # onto the font's own GSUB/GPOS (keeping Noto's vowel-sign, mark and kerning rules).
    import io, copy
    buf = io.BytesIO(); f.save(buf); buf.seek(0)
    scratch = TTFont(buf)
    addOpenTypeFeaturesFromString(scratch, fea, tables=['GSUB', 'GPOS'])
    for tag in ('GSUB', 'GPOS'):
        graft(f[tag].table, scratch[tag].table)

    # room below the line for one stacked letter
    depth = round(max(-geo[s]['bottom'] for s in subs.values()) + 60)
    for t, attr in (('hhea', 'descent'), ('OS/2', 'sTypoDescender')):
        setattr(f[t], attr, -max(abs(getattr(f[t], attr)), depth))
    f['OS/2'].usWinDescent = max(f['OS/2'].usWinDescent, depth)

    # rename (OFL Reserved Font Name "Noto")
    name = f['name']
    for rec in list(name.names):
        if rec.nameID in (1, 3, 4, 6, 16):
            val = {1: family, 3: family + ' Regular 1.0', 4: family, 6: family.replace(' ', '') + '-Regular', 16: family}[rec.nameID]
            rec.string = val
    name.setName(f'Modified by Maataa from {os.path.basename(src).split("-")[0]} (SIL Open Font License 1.1): stacked conjuncts added.', 10, 3, 1, 0x409)
    f.flavor = 'woff2'
    f.save(out)
    return len(subs)


if __name__ == '__main__':
    folder = sys.argv[1] if len(sys.argv) > 1 else '.'
    only = sys.argv[2:] or list(CONFIG)
    for code in only:
        src_name, family, slug = CONFIG[code]
        out = os.path.join(ROOT, 'public', 'fonts', 'lipi', f'maataa-lipi-{slug}.woff2')
        n = build(code, os.path.join(folder, src_name), out, family)
        print(f'{code}: {n} subjoined forms -> {os.path.relpath(out, ROOT)} ({os.path.getsize(out)} bytes)')
