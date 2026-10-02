"""python -m unittest discover -s tests  (from the guru folder)"""
import json
import os
import shutil
import sys
import tempfile
import unittest

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from guru.config import preset, GuruConfig, PRESETS
from guru.model import GuruForCausalLM
from guru import panini

TINY = dict(vocab_size=400, d_model=64, n_layer=2, n_head=4, n_kv_head=2, ffn_dim=128, max_seq_len=64)

SAMPLE = """संस्कृतं भारतस्य प्राचीना भाषा अस्ति। गुरुः शिष्यं ज्ञानं ददाति। विद्या ददाति विनयम्।
हिंदी भारत की एक प्रमुख भाषा है। फ़िल्म की शूटिंग सुबह छह बजे शुरू होगी। निर्देशक ने दृश्य समझाया।
The line producer plans the shoot day by day. Every scene needs a location, a cast list and a call time.
""" * 40


class ModelTests(unittest.TestCase):
    def test_parameter_count_matches_config(self):
        for name in ("nano", "mini"):
            cfg = preset(name)
            self.assertEqual(GuruForCausalLM(cfg).num_parameters(), cfg.n_params(), name)

    def test_causal(self):
        torch.manual_seed(0)
        m = GuruForCausalLM(GuruConfig(**TINY)).eval()
        x = torch.randint(0, 400, (1, 20))
        y = x.clone(); y[0, 15:] = (y[0, 15:] + 7) % 400
        a, _ = m(x); b, _ = m(y)
        self.assertTrue(torch.allclose(a[0, :15], b[0, :15], atol=1e-5), "earlier tokens must not see later ones")
        self.assertFalse(torch.allclose(a[0, 15:], b[0, 15:]))

    def test_learns_a_pattern(self):
        torch.manual_seed(0)
        m = GuruForCausalLM(GuruConfig(**TINY))
        opt = torch.optim.AdamW(m.parameters(), lr=3e-3)
        seq = torch.arange(0, 60).remainder(10).unsqueeze(0) + 5
        first = None
        for _ in range(80):
            _, loss = m(seq[:, :-1], seq[:, 1:]); opt.zero_grad(); loss.backward(); opt.step()
            first = first or loss.item()
        self.assertLess(loss.item(), first * 0.2)
        out = m.generate(seq[:, :12], max_new_tokens=8, temperature=0)
        self.assertEqual(out[0, 12:].tolist(), seq[0, 12:20].tolist())

    def test_too_long_is_refused(self):
        m = GuruForCausalLM(GuruConfig(**TINY))
        with self.assertRaises(ValueError):
            m(torch.zeros((1, 65), dtype=torch.long))


class HFCompatTests(unittest.TestCase):
    """The exported folder must load as a standard LlamaForCausalLM and give the same logits."""
    def test_same_logits_as_transformers_llama(self):
        try:
            from transformers import LlamaForCausalLM
        except Exception:
            self.skipTest("transformers not installed")
        from guru.export import to_hf
        torch.manual_seed(1)
        cfg = GuruConfig(**TINY)
        m = GuruForCausalLM(cfg).eval()
        tmp = tempfile.mkdtemp()
        try:
            tokdir = os.path.join(tmp, "tok"); os.makedirs(tokdir)
            corpus = os.path.join(tmp, "c.txt"); open(corpus, "w").write(SAMPLE)
            from guru.tokenizer import train
            train(corpus, os.path.join(tokdir, "t"), 400)
            ck = os.path.join(tmp, "best.pt")
            torch.save({"model": m.state_dict(), "config": json.loads(cfg.to_json()), "step": 0, "val_loss": None}, ck)
            hf = to_hf(ck, os.path.join(tmp, "hf"), os.path.join(tokdir, "t.model"), dtype=torch.float32)
            ref = LlamaForCausalLM.from_pretrained(hf, torch_dtype=torch.float32).eval()
            x = torch.randint(0, 400, (2, 33))
            with torch.no_grad():
                ours, _ = m(x); theirs = ref(x).logits
            self.assertTrue(torch.allclose(ours, theirs, atol=1e-4), float((ours - theirs).abs().max()))
        finally:
            shutil.rmtree(tmp)


class TokenizerTests(unittest.TestCase):
    def test_devanagari_round_trip_and_byte_fallback(self):
        from guru.tokenizer import train, Tokenizer
        tmp = tempfile.mkdtemp()
        try:
            corpus = os.path.join(tmp, "c.txt"); open(corpus, "w").write(SAMPLE)
            open(os.path.join(tmp, "dhatus.txt"), "w").write("# roots\nगम्\nकृ\n")
            kept = train(corpus, os.path.join(tmp, "t"), 400, os.path.join(tmp, "dhatus.txt"))
            self.assertEqual(kept, ["कृ", "गम्"])
            tok = Tokenizer(os.path.join(tmp, "t.model"))
            for text in ["गुरुः शिष्यं ज्ञानं ददाति।", "फ़िल्म की शूटिंग", "Call time 06:30", "ঈ unseen script 🙂"]:
                self.assertEqual(tok.decode(tok.encode(text, bos=True, eos=True)), text)
            self.assertIn("गम्", [tok.sp.id_to_piece(i) for i in range(tok.vocab_size)])
        finally:
            shutil.rmtree(tmp)


class PaniniTests(unittest.TestCase):
    def test_well_formed_text_scores_one(self):
        r = panini.verify("गुरुः शिष्यं ज्ञानं ददाति। फ़िल्म की शूटिंग।")
        self.assertTrue(r["ok"], r); self.assertEqual(r["score"], 1.0)

    def test_broken_script_is_flagged(self):
        self.assertEqual({i["rule"] for i in panini.verify("ि गुरु")["issues"]}, {"P1"})
        self.assertEqual({i["rule"] for i in panini.verify("गुुरु")["issues"]}, {"P2"})
        self.assertEqual({i["rule"] for i in panini.verify("गुरुabc")["issues"]}, {"P4"})
        self.assertFalse(panini.keep_line("्् ा ि"))
        self.assertTrue(panini.keep_line("English only line"))


class LipiTests(unittest.TestCase):
    TEXT = "गुरुः शिष्यं ज्ञानं ददाति। ऋषिः आगच्छति। ईश्वरः ऊर्जा ऐरावतः औषधम् कै कौ अं अः"

    def test_round_trip_through_each_script(self):
        from guru import lipi
        for script in ("brahmi", "kharoshthi", "siddham"):
            t, notes = lipi.from_deva(self.TEXT, script)
            self.assertEqual({s for s, _ in lipi.detect(t)}, {script}, script)
            self.assertEqual(lipi.to_deva(t), self.TEXT, script)
        self.assertIn("Guru convention", lipi.from_deva("ऐ", "kharoshthi")[1][0])

    def test_kharoshthi_vowels_and_length(self):
        from guru import lipi
        A, I, LEN = lipi.K_A, lipi.K_SIGN["I"], lipi.K_LEN
        self.assertEqual(lipi.to_deva(A + I), "इ")
        self.assertEqual(lipi.to_deva(A + I + LEN), "ई")
        self.assertEqual(lipi.to_deva(A + LEN), "आ")
        self.assertIn("additive", " ".join(lipi.from_deva("१२", "kharoshthi")[1]))

    def test_special_marks(self):
        from guru import lipi
        sep = unicodedata_lookup("SIDDHAM SEPARATOR BAR")
        self.assertEqual(lipi.to_deva(sep), "।")
        alt = unicodedata_lookup("SIDDHAM VOWEL SIGN ALTERNATE U")
        ka = unicodedata_lookup("SIDDHAM LETTER KA")
        self.assertEqual(lipi.to_deva(ka + alt), "कु")
        self.assertEqual(lipi.to_deva(unicodedata_lookup("BRAHMI SIGN JIHVAMULIYA")), "\u1CF5")
        self.assertEqual(lipi.from_deva("फ़", "brahmi")[1], ["nukta dropped (no equivalent)"])
        self.assertEqual(lipi.to_deva("English stays"), "English stays")

    def test_same_tokens_in_any_script_and_panini_checks_them(self):
        from guru import lipi
        from guru.tokenizer import train, Tokenizer
        tmp = tempfile.mkdtemp()
        try:
            corpus = os.path.join(tmp, "c.txt"); open(corpus, "w").write(SAMPLE)
            train(corpus, os.path.join(tmp, "t"), 400)
            tok = Tokenizer(os.path.join(tmp, "t.model"))
            line = "गुरुः शिष्यं ज्ञानं ददाति।"
            base = tok.encode(line)
            for script in ("brahmi", "kharoshthi", "siddham"):
                written = lipi.from_deva(line, script)[0]
                self.assertEqual(tok.encode(written), base, script)
                self.assertEqual(tok.decode(base, script=script), written, script)
        finally:
            shutil.rmtree(tmp)
        broken = lipi.from_deva("गुरु", "brahmi")[0]
        broken = broken[:2] + broken[1] + broken[2:]  # doubled vowel sign
        self.assertEqual({i["rule"] for i in panini.verify(broken)["issues"]}, {"P2"})


def unicodedata_lookup(name):
    import unicodedata
    return unicodedata.lookup(name)


if __name__ == "__main__":
    unittest.main()
