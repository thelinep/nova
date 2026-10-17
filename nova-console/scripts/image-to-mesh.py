#!/usr/bin/env python3
"""Maataa — one picture to a 3D mesh (.glb) with TripoSR (MIT licence, Stability AI and Tripo AI).

  python image-to-mesh.py --image IN.png --out OUT.glb [--resolution 256] [--keep-background]

Runs in the environment made by scripts/add-image-to-3d-mac.sh (TRIPOSR_DIR holds the
TripoSR code in ./TripoSR and the weights in ./hf). Prints "PROGRESS <text>" lines for the app.
torchmcubes (which needs a C++ build) is replaced by PyMCubes through a small shim.
"""
import argparse, os, sys, types

def progress(text):
    print('PROGRESS ' + text, flush=True)

def install_mcubes_shim():
    import numpy as np, torch, mcubes
    def marching_cubes(vol, thresh):
        arr = vol.detach().cpu().numpy() if hasattr(vol, 'detach') else np.asarray(vol)
        v, f = mcubes.marching_cubes(arr.astype(np.float64), float(thresh))
        # torchmcubes returns (x, y, z) with x along the last axis; TripoSR swaps them back.
        v = np.ascontiguousarray(v[:, ::-1])
        return torch.from_numpy(v.astype(np.float32)), torch.from_numpy(f.astype(np.int64))
    sys.modules['torchmcubes'] = types.SimpleNamespace(marching_cubes=marching_cubes)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--resolution', type=int, default=256); ap.add_argument('--keep-background', action='store_true')
    ap.add_argument('--device', default=os.environ.get('NOVA_TRIPOSR_DEVICE', 'auto'))
    a = ap.parse_args()
    base = os.environ.get('TRIPOSR_DIR') or os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, os.path.join(base, 'TripoSR'))
    os.environ.setdefault('HF_HOME', os.path.join(base, 'hf'))
    os.environ.setdefault('U2NET_HOME', os.path.join(base, 'u2net'))
    os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')

    progress('Loading TripoSR…')
    import numpy as np, torch, trimesh
    from PIL import Image
    install_mcubes_shim()
    from tsr.system import TSR
    from tsr.utils import remove_background, resize_foreground

    image = Image.open(a.image)
    image.load()
    if a.keep_background:
        image = image.convert('RGB')
    else:
        progress('Removing the background…')
        import rembg
        image = remove_background(image.convert('RGBA'), rembg.new_session())
        image = resize_foreground(image, 0.85)
        arr = np.array(image).astype(np.float32) / 255.0
        arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
        image = Image.fromarray((arr * 255.0).astype(np.uint8))

    device = a.device
    if device == 'auto':
        device = 'mps' if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available() else 'cpu'
    model = TSR.from_pretrained('stabilityai/TripoSR', config_name='config.yaml', weight_name='model.ckpt')
    model.renderer.set_chunk_size(8192)

    def run(dev):
        model.to(dev)
        progress('Reading the picture (' + dev + ')…')
        with torch.no_grad():
            codes = model([image], device=dev)
        progress('Building the mesh…')
        try:
            return model.extract_mesh(codes, True, resolution=a.resolution)[0]
        except TypeError:  # older TripoSR: extract_mesh(scene_codes, resolution)
            return model.extract_mesh(codes, resolution=a.resolution)[0]
    try:
        mesh = run(device)
    except Exception as e:  # some operations are missing on Apple GPUs in some PyTorch versions
        if device == 'cpu':
            raise
        progress('Apple GPU failed (' + str(e)[:80] + '); trying the CPU…')
        mesh = run('cpu')

    if len(mesh.faces) == 0:
        raise SystemExit('No shape was found in the picture. Try a picture with one character on a plain background.')
    # Y up, facing the camera (the same turn TripoSR's own viewer uses), standing on y = 0.
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
    try:
        if mesh.volume < 0:
            mesh.invert()
    except Exception:
        pass
    lo, hi = mesh.bounds
    mesh.apply_translation([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    progress('Saving…')
    tmp = a.out + '.part'
    mesh.export(tmp, file_type='glb')
    os.replace(tmp, a.out)
    print('DONE vertices=%d faces=%d' % (len(mesh.vertices), len(mesh.faces)), flush=True)

if __name__ == '__main__':
    main()
