"""python -m guru <command>

  corpus     download Wikipedia (sa, hi, en) and build data/corpus.txt with your texts
  build      build data/corpus.txt from what is already downloaded plus data/my_texts
  tokenizer  train Guru-Dhatu (SentencePiece) on the corpus
  encode     turn the corpus into data/train.bin and data/val.bin
  prepare    build + tokenizer + encode
  train      train a size (nano, mini, small, base-1b, 7b)
  teach      instruction-tune a trained model on question/answer pairs (JSONL)
  ask        let a trained model continue text or answer
  check      run Guru-Panini on a piece of text (script and Ashtadhyayi citations)
  sutra      show Ashtadhyayi sutras by number, or find them by words
  dhatu      look up a root in the Dhatupatha
  lipi       convert between Devanagari, Brahmi, Kharoshthi and Siddham
  export     checkpoint → Hugging Face folder → GGUF (→ Ollama with --ollama NAME)
  sizes      list the sizes with parameter counts and token budgets
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "out")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="guru", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("corpus"); c.add_argument("--langs", default="sa,hi,en"); c.add_argument("--cap-mb", default="", help="e.g. sa=80,hi=250,en=250"); c.add_argument("--own-weight", type=int, default=3); c.add_argument("--panini-weight", type=int, default=3)
    b = sub.add_parser("build"); b.add_argument("--own-weight", type=int, default=3); b.add_argument("--panini-weight", type=int, default=3)
    t = sub.add_parser("tokenizer"); t.add_argument("--vocab", type=int, default=0); t.add_argument("--size", default="nano")
    sub.add_parser("encode")
    p = sub.add_parser("prepare"); p.add_argument("--size", default="nano"); p.add_argument("--vocab", type=int, default=0); p.add_argument("--own-weight", type=int, default=3); p.add_argument("--panini-weight", type=int, default=3)
    tr = sub.add_parser("train"); tr.add_argument("--size", default="nano"); tr.add_argument("--minutes", type=float); tr.add_argument("--tokens", type=float)
    tr.add_argument("--micro-bs", type=int); tr.add_argument("--resume", action="store_true"); tr.add_argument("--device"); tr.add_argument("--eval-every", type=int, default=200); tr.add_argument("--lr", type=float); tr.add_argument("--compile", action="store_true")
    te = sub.add_parser("teach"); te.add_argument("--size", default="nano"); te.add_argument("--pairs", default=""); te.add_argument("--panini", action="store_true", help="add question/answer pairs built from the Ashtadhyayi and Dhatupatha"); te.add_argument("--minutes", type=float, default=20); te.add_argument("--device")
    a = sub.add_parser("ask"); a.add_argument("text"); a.add_argument("--size", default="nano"); a.add_argument("--instruct", action="store_true"); a.add_argument("--tokens", type=int, default=120); a.add_argument("--temperature", type=float, default=0.8); a.add_argument("--script", default="devanagari", choices=["devanagari", "brahmi", "kharoshthi", "siddham"])
    ch = sub.add_parser("check"); ch.add_argument("text")
    su = sub.add_parser("sutra"); su.add_argument("query", nargs="+", help="a number like 1.1.1, a range like 1.1.1-1.1.10, or words to find"); su.add_argument("--script", default="devanagari", choices=["devanagari", "iast", "slp1", "brahmi", "kharoshthi", "siddham"])
    dh = sub.add_parser("dhatu"); dh.add_argument("root")
    li = sub.add_parser("lipi"); li.add_argument("text"); li.add_argument("--to", default="devanagari", choices=["devanagari", "brahmi", "kharoshthi", "siddham"])
    ex = sub.add_parser("export"); ex.add_argument("--size", default="nano"); ex.add_argument("--instruct", action="store_true"); ex.add_argument("--ollama", default=""); ex.add_argument("--no-gguf", action="store_true")
    sub.add_parser("sizes")
    args = ap.parse_args(argv)

    from .config import PRESETS, preset
    vocab_for = lambda size, v: v or PRESETS[size]["vocab_size"]
    tok_path = os.path.join(DATA, "guru-dhatu.model")
    out_for = lambda size, instruct=False: os.path.join(OUT, PRESETS[size]["name"] + ("-instruct" if instruct else ""))

    if args.cmd == "sizes":
        for k in PRESETS:
            cfg = preset(k)
            print(f"{k:8} {cfg.name:20} {cfg.n_params()/1e6:9,.1f}M params · context {cfg.max_seq_len:5} · budget {cfg.train_tokens/1e9:6.1f}B tokens")
        return
    if args.cmd == "lipi":
        from .lipi import convert, detect, FONTS, LABELS
        text, notes = convert(args.text, args.to)
        print(text)
        found = ", ".join(f"{LABELS[s]} {int(p*100)}%" for s, p in detect(args.text))
        print(f"\n[from: {found or 'no Indic script'}{' · ' + '; '.join(notes) if notes else ''}{' · font: ' + FONTS[args.to] if args.to in FONTS else ''}]")
        return
    if args.cmd == "check":
        from .panini import verify
        from .sutra import check_citations
        print(json.dumps({**verify(args.text), "citations": check_citations(args.text)}, ensure_ascii=False, indent=2)); return
    if args.cmd == "sutra":
        from . import sutra, slp1
        q = " ".join(args.query).strip()
        m = re.fullmatch(r"([1-8]\.[1-4]\.\d+)\s*-\s*([1-8]\.[1-4]\.\d+)", q)
        if m:
            ids = [s["id"] for s in sutra.sutras()]
            if m.group(1) not in ids or m.group(2) not in ids:
                sys.exit("No such sutra number in that range.")
            rows = list(sutra.sutras())[ids.index(m.group(1)):ids.index(m.group(2)) + 1]
        elif sutra.ID.match(q):
            s = sutra.get(q)
            if not s:
                sys.exit(f"There is no sutra {q}. The Ashtadhyayi has {sutra.TOTAL_SUTRAS:,} sutras; for example pada 1.1 ends at 1.1.75.")
            rows = [s]
        else:
            rows = sutra.find(q)
            if not rows:
                sys.exit("No sutra contains those words.")
        for s in rows:
            print(f"{s['id']:8} {slp1.convert(s['slp1'], args.script)}")
        return
    if args.cmd == "dhatu":
        from . import sutra
        rows = sutra.dhatu(args.root)
        if not rows:
            sys.exit("Not found in the Dhatupatha.")
        for d in rows:
            print(f"{d['code']}  {d['deva']:12} {d['artha']}  ({d['gana_name']}गण)")
        return
    if args.cmd in ("corpus", "build", "prepare"):
        from .data import fetch_wikipedia, build_corpus
        if args.cmd == "corpus":
            caps = {kv.split("=")[0]: int(kv.split("=")[1]) for kv in args.cap_mb.split(",") if "=" in kv}
            fetch_wikipedia(DATA, [l for l in args.langs.split(",") if l], caps)
        s = build_corpus(DATA, own_weight=args.own_weight, panini_weight=args.panini_weight)
        print(f"Corpus: {s['documents']:,} documents, {s['characters']/1e6:,.1f}M characters")
        for k, v in s["sources"].items():
            print(f"  {k:12} {v['docs']:>8,} docs  {v['chars']/1e6:8,.1f}M chars  ({v['dupes']} duplicates dropped)")
        if args.cmd != "prepare":
            return
    if args.cmd in ("tokenizer", "prepare"):
        from .data import write_tokenizer_input
        from .tokenizer import train as train_tok
        inp = write_tokenizer_input(os.path.join(DATA, "corpus.txt"), os.path.join(DATA, "tokenizer-input.txt"))
        kept = train_tok(inp, os.path.join(DATA, "guru-dhatu"), vocab_for(args.size, args.vocab), os.path.join(DATA, "dhatus.txt"))
        os.remove(inp)
        print(f"Guru-Dhatu trained: {vocab_for(args.size, args.vocab)} pieces" + (f", {len(kept)} dhatus kept whole" if kept else ""))
        if args.cmd != "prepare":
            return
    if args.cmd in ("encode", "prepare"):
        from .data import encode_corpus
        encode_corpus(DATA, tok_path); return
    if args.cmd == "train":
        from .train import train
        ov = {"lr": args.lr} if args.lr else {}
        train(args.size, DATA, out_for(args.size), tok_path, minutes=args.minutes, tokens=args.tokens, micro_bs=args.micro_bs,
              resume=args.resume, device=args.device, eval_every=args.eval_every, compile_model=args.compile, overrides=ov); return
    if args.cmd == "teach":
        from .train import train
        base = os.path.join(out_for(args.size), "best.pt")
        if not os.path.exists(base):
            sys.exit(f"Train {args.size} first: {base} is missing.")
        pairs = args.pairs
        if args.panini:
            from .sutra import teach_pairs
            pairs = os.path.join(DATA, "teach-combined.jsonl")
            with open(pairs, "w", encoding="utf-8") as f:
                if args.pairs:
                    f.write(open(args.pairs, encoding="utf-8").read().rstrip("\n") + "\n")
                for r in teach_pairs():
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        if not pairs:
            sys.exit("Give --pairs FILE, --panini, or both.")
        train(args.size, DATA, out_for(args.size, True), tok_path, minutes=args.minutes, sft=pairs, init_from=base, device=args.device, eval_every=50); return
    if args.cmd == "ask":
        import torch
        from .config import GuruConfig
        from .model import GuruForCausalLM
        from .tokenizer import Tokenizer, EOS
        from .train import pick_device, PROMPT_TEMPLATE
        path = os.path.join(out_for(args.size, args.instruct), "best.pt")
        if not os.path.exists(path):
            sys.exit(f"No trained model at {path}.")
        ck = torch.load(path, map_location="cpu", weights_only=False)
        dev = pick_device()
        model = GuruForCausalLM(GuruConfig.from_dict(ck["config"])).to(dev); model.load_state_dict(ck["model"])
        tok = Tokenizer(ck.get("tokenizer") or tok_path)
        prompt = PROMPT_TEMPLATE.format(prompt=args.text) if args.instruct else args.text
        ids = torch.tensor([tok.encode(prompt, bos=True)], device=dev)
        out = model.generate(ids, max_new_tokens=args.tokens, temperature=args.temperature, eos_id=EOS)
        text = tok.decode(out[0].tolist())
        shown = text[len(prompt):].strip() if args.instruct and text.startswith(prompt) else text
        if args.script != "devanagari":
            from .lipi import from_deva
            shown, notes = from_deva(shown, args.script)
            if notes:
                print("[" + "; ".join(notes) + "]")
        print(shown or "(Guru ended without writing anything; it may need more training, or try a higher --temperature.)")
        from .panini import verify
        from .sutra import check_citations
        v = verify(text); print(f"\n[Guru-Panini: score {v['score']:.2f}{', issues: ' + ', '.join(sorted({i['rule'] for i in v['issues']})) if v['issues'] else ''}]")
        for c in check_citations(shown if args.script == "devanagari" else text):
            if c["status"] == "unknown":
                print(f"[Guru-Panini: {c['id']} is not an Ashtadhyayi sutra]")
            elif c["status"] == "mismatch":
                print(f"[Guru-Panini: {c['id']} is {c['expected']}; the quoted words are {c['looks_like']}]")
        return
    if args.cmd == "export":
        from .export import to_hf, to_gguf, to_ollama
        from .config import GuruConfig
        import torch
        folder = out_for(args.size, args.instruct)
        ck_path = os.path.join(folder, "best.pt")
        if not os.path.exists(ck_path):
            sys.exit(f"No trained model at {ck_path}.")
        hf = to_hf(ck_path, os.path.join(folder, "hf"), tok_path)
        print("Hugging Face folder:", hf)
        if args.no_gguf:
            return
        cfg = GuruConfig.from_dict(torch.load(ck_path, map_location="cpu", weights_only=False)["config"])
        gguf = to_gguf(hf, os.path.join(folder, f"{cfg.name}-f16.gguf"), os.path.join(HERE, "tools"))
        print("GGUF:", gguf)
        if args.ollama:
            to_ollama(gguf, args.ollama, cfg); print("Ollama model:", args.ollama)


if __name__ == "__main__":
    main()
