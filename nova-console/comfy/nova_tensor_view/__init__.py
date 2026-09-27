"""NOVA tensor view — a tiny ComfyUI add-on used by NOVA's live "Tensor view".

ComfyUI can show a small picture of the latent tensor after each sampler step, but only for
latents it knows how to turn into RGB (images, most video). Audio latents such as
ACE-Step's have no RGB projection, so ComfyUI shows nothing for songs.

This add-on fills that gap: when ComfyUI has no previewer for a latent, it draws the tensor
itself as a heatmap — one row per channel (and frequency band), time running left to right,
amber for positive values, blue for negative, dark for zero. It changes nothing else: image
previews, sampling and outputs are untouched. It only runs when a prompt asks for previews
(NOVA asks for them per prompt).
"""
import logging

import torch
from PIL import Image

import latent_preview
from comfy.cli_args import LatentPreviewMethod

_BASE = torch.tensor([14.0, 14.0, 20.0])
_POS = torch.tensor([255.0, 176.0, 48.0])
_NEG = torch.tensor([64.0, 140.0, 255.0])


def tensor_heatmap(x0, width=768, height=320):
    """Draws a latent (batch first) as a rows x time heatmap. Returns a PIL image."""
    t = x0
    if getattr(t, "is_nested", False):
        t = t.tensors[0]
    t = t[0].detach().to(device="cpu", dtype=torch.float32)
    if t.ndim == 1:
        t = t.unsqueeze(0)
    elif t.ndim >= 3:
        t = t.reshape(-1, t.shape[-1])
    rows, cols = t.shape
    t = t - t.mean()
    scale = t.std().item() * 2.5 + 1e-6
    v = (t / scale).clamp(-1.0, 1.0)
    pos = v.clamp(min=0).unsqueeze(-1)
    neg = (-v).clamp(min=0).unsqueeze(-1)
    rgb = (_BASE + pos * (_POS - _BASE) + neg * (_NEG - _BASE)).clamp(0, 255).to(torch.uint8)
    img = Image.fromarray(rgb.numpy(), mode="RGB")
    w = max(64, min(width, cols if cols >= 256 else cols * max(1, 256 // max(cols, 1))))
    img = img.resize((w, rows), Image.BOX if cols > w else Image.NEAREST)
    row_px = max(1, round(height / rows))
    return img.resize((w, rows * row_px), Image.NEAREST)


class NovaTensorPreviewer(latent_preview.LatentPreviewer):
    def decode_latent_to_preview(self, x0):
        return tensor_heatmap(x0)


if not getattr(latent_preview, "_nova_tensor_view", False):
    _original_get_previewer = latent_preview.get_previewer

    def get_previewer(device, latent_format):
        previewer = _original_get_previewer(device, latent_format)
        if previewer is None and latent_preview.args.preview_method != LatentPreviewMethod.NoPreviews:
            previewer = NovaTensorPreviewer()
        return previewer

    latent_preview.get_previewer = get_previewer
    latent_preview._nova_tensor_view = True
    logging.info("NOVA tensor view: audio latents now get step previews.")


class NovaTensorView:
    """Marker node: lets NOVA check that this add-on is loaded. It does nothing if used."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "NOVA"
    DESCRIPTION = "Shows that NOVA's tensor view add-on is installed (audio latent previews)."

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {"NovaTensorView": NovaTensorView}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaTensorView": "NOVA tensor view (installed)"}
