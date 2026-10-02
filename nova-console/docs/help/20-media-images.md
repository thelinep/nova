---
id: media-images
title: Images
section: Create
order: 20
summary: Generate and change images on this computer with ComfyUI, keep a character consistent with a LoRA, and edit, expand or upscale any picture.
keywords: image generation comfyui sdxl checkpoint lora image to image edit area remove object expand background upscale seed recipe media tensor view
views: media
---
Everything in **Media** runs on your computer, and every item keeps the settings that made it (its recipe). Tabs along the top separate **Image**, **Video**, **Audio**, **Transcribe**, **Edit** and **Library**; the panel on the right explains the current tab, lists anything still to install, offers prompt presets and shows that tab's recent jobs with **Cancel**.

@screen media/media-image.jpg "Media > Image: prompt, settings, and the helper panel with presets."

## Set up ComfyUI

1. Open **Settings > Image engine** and press **Install ComfyUI** (or double-click **Install ComfyUI for NOVA.command** in the brahmini folder). It installs ComfyUI in `~/ComfyUI` with the SDXL base checkpoint (about 15 GB) and shows its progress in **Activity**.
2. That is all: you do not need to start ComfyUI yourself.

## ComfyUI is started for you

@screen media/comfy-settings.jpg "Settings > Image engine: Maataa starts, stops and restarts ComfyUI."

- **Start ComfyUI when needed** (on by default): the first image, video, song or sound effect starts ComfyUI, waits until it is ready and then runs the job. The first job takes about 20–60 seconds longer while ComfyUI loads.
- **Start with Maataa**: ComfyUI is ready straight away, but uses memory even when you are not making media.
- **Stop when idle**: gives the memory back after 10, 20 or 60 quiet minutes; it starts again by itself next time.
- When Maataa quits, it stops the ComfyUI it started, even if Maataa itself is closed suddenly. If ComfyUI crashes, Maataa restarts it, up to three times in ten minutes.
- **Start now**, **Stop**, **Restart** and **Show log** are there when you need them. **ComfyUI folder** points Maataa at ComfyUI installed somewhere other than `~/ComfyUI`.
- A ComfyUI you started yourself, or the **ComfyUI Desktop** app (port 8000), is used as it is and left running when Maataa quits. If only the Desktop app is installed, Maataa opens it when needed.
- Set `COMFYUI_URL` for another local port. Only local addresses are accepted.

Until ComfyUI has started, the Image tab shows **COMFYUI OFFLINE**; generating starts it.

## Generate an image

1. Describe the picture. Click preset chips (shot size, lens, light, style) to add them.
2. Optionally add a negative prompt (things to avoid).
3. Choose the checkpoint, size, steps, CFG, seed and sampler, then **Generate**.

Each image is saved with its prompt, negative prompt, checkpoint and seed. **Reuse settings** loads them back.

**Click an image** to see it full size in Maataa's viewer, with its prompt, model and seed underneath. Use ‹ › or the arrow keys to step through the other images in the list, click the picture to zoom to 100%, **Download** to save a copy, and Esc or **Close** to go back. Images in chat, screenshots from the Agent Browser and character faces open the same way. While ComfyUI works, the **Tensor view** opens at the bottom right and shows each denoising step; see [Boards, Timeline and Library](help:boards-library#tensor-view).

## Start from another image

Set **Start from** to a library image, or **Upload image**, describe the change, and set **Change**: 0.1 stays close to the original, 0.9 reimagines it. The source is scaled to about one megapixel first.

## Keep a style or character with a LoRA

**Style / character** picks a LoRA file from `ComfyUI/models/loras` (restart ComfyUI after adding one); **Strength** 0.6–0.9 is typical. It is used for text to image, image to image, Edit area, Remove object and Expand, and recorded in each recipe. A LoRA trained on one character is the most reliable way to keep that character the same across shots. Training your own LoRA is not built in yet.

## Change an existing image

Every library card has **Actions ▾**. The original is never changed; each action makes a new item.

| Action | What it does |
| --- | --- |
| Edit area… | Paint over an area and describe what should be there. Change 0.3 stays close, 1 repaints fully. Only painted pixels change. |
| Remove object… | Paint over something and Maataa fills it with matching background. |
| Expand background… | Puts the picture on a bigger frame (16:9, 2.39:1, 9:16, more room on every side) and paints the new area to match. |
| Upscale… | Makes a 2× or 4× copy. With an upscale model (double-click **Add upscale model.command**, about 64 MB) it adds real detail; otherwise it is a high-quality resize. Limited to 8,192 pixels on the long side. |
| Image to image, Attach to chat, Animate, Filters | Start from this picture elsewhere |

## Filters

**Filters** on any item (or the Edit tab) applies looks (black & white, warm, cool, teal & orange, vintage, high contrast, faded film), film grain, vignette, crops (16:9, 2.39:1, 4:3, 1:1, 4:5, 9:16) and resizing. The result is a new item with its settings in the recipe.
