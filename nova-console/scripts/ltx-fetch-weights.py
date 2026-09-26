#!/usr/bin/env python3
"""NOVA: download only the LTX-2 weights NOVA uses, instead of the whole ~60 GB repository.

  Fast mode (default, --distilled): distilled transformer + connector + VAEs + audio + spatial
  upscaler (about 21 GB) and the Gemma 3 12B 4-bit text encoder (about 7.5 GB).
  --better also adds the dev transformer and distilled LoRA for "Better" (two-stage) clips (+19 GB).

It first removes unfinished downloads and any files NOVA does not use from the Hugging Face
cache of this repository, then checks there is room, then downloads. Run with the ltx-2-mlx
virtualenv's Python (the installer does this). Prints the local folder NOVA passes to --model.
"""
import argparse, fnmatch, os, shutil, sys
from pathlib import Path

REPO = os.environ.get("LTX_MLX_MODEL", "dgrauet/ltx-2.3-mlx-q4")
GEMMA = "mlx-community/gemma-3-12b-it-4bit"
FAST = ["*.json", "transformer-distilled-1.1.safetensors", "connector.safetensors", "vae_encoder.safetensors",
        "vae_decoder.safetensors", "audio_vae.safetensors", "vocoder.safetensors", "spatial_upscaler_x2_v1_1.safetensors"]
BETTER = ["transformer-dev.safetensors", "ltx-2.3-22b-distilled-lora-384.safetensors"]
GB = 1024 ** 3


def cache_dir(repo):
    from huggingface_hub.constants import HF_HUB_CACHE
    return Path(HF_HUB_CACHE) / ("models--" + repo.replace("/", "--"))


def wanted(name, patterns):
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def prune(repo, patterns, keep_hashes=()):
    """Deletes snapshot files NOVA does not use and unfinished downloads of them (unfinished
    downloads of wanted files, named by their hash, are kept so they resume). Returns bytes freed."""
    root, freed = cache_dir(repo), 0
    blobs = root / "blobs"
    if blobs.is_dir():
        for b in blobs.glob("*.incomplete"):
            if b.name[:-len(".incomplete")] in keep_hashes:
                continue
            freed += b.stat().st_size; b.unlink()
    snaps = [f for snap in (root / "snapshots").glob("*") for f in snap.iterdir()] if (root / "snapshots").is_dir() else []
    keep = {f.resolve() for f in snaps if wanted(f.name, patterns)}
    for f in snaps:
        if wanted(f.name, patterns):
            continue
        target = f.resolve()
        if target.exists() and target not in keep and target != f:
            freed += target.stat().st_size; target.unlink()
        f.unlink()
    return freed


def missing_bytes(repo, patterns, files_meta):
    from huggingface_hub import try_to_load_from_cache
    total = 0
    for f in files_meta:
        if not wanted(f.rfilename, patterns):
            continue
        cached = try_to_load_from_cache(repo, f.rfilename)
        if not (isinstance(cached, str) and os.path.exists(cached)):
            total += f.size or 0
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--better", action="store_true", help="also download the files for Better (two-stage) clips")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    from huggingface_hub import HfApi, snapshot_download
    patterns = FAST + (BETTER if a.better else [])
    api = HfApi()
    files = api.model_info(REPO, files_metadata=True).siblings
    sha = lambda f: (f.lfs.get("sha256") if isinstance(f.lfs, dict) else getattr(f.lfs, "sha256", None)) if getattr(f, "lfs", None) else None
    keep = {sha(f) for f in files if wanted(f.rfilename, patterns)} - {None}
    freed = prune(REPO, patterns, keep)
    if freed:
        print(f"Removed {freed / GB:.1f} GB of unfinished or unused LTX-2 downloads.")
    need = missing_bytes(REPO, patterns, files)
    need += missing_bytes(GEMMA, ["*"], api.model_info(GEMMA, files_metadata=True).siblings)
    free = shutil.disk_usage(Path.home()).free
    print(f"To download: {need / GB:.1f} GB · free now: {free / GB:.1f} GB")
    if need + 3 * GB > free:
        print(f"Not enough disk space: free about {(need + 3 * GB - free) / GB:.0f} GB more and run this again.")
        return 2
    if a.dry_run:
        return 0
    path = snapshot_download(REPO, allow_patterns=patterns)
    snapshot_download(GEMMA)
    print("LTX_MODEL_DIR=" + path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
