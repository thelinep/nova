const { test, expect } = require('@playwright/test');

test('Character Studio: design a puppet, make an action and record it to the Library', async ({ page, request }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="charstudio"]').click();
  await expect(page.locator('#charstudioView')).toHaveClass(/active/);
  await page.locator('#csNew').click();
  await expect(page.locator('#csCanvas')).toBeVisible();

  // Look: start from the robot look and rename.
  await page.locator('[data-look="inchi"]').click();
  await page.locator('#csName').fill('Studio Robot');
  await expect(page.locator('#csSave')).toHaveText('Save');
  await page.locator('#csSave').click();
  await expect(page.locator('#csSave')).toHaveText('Saved');

  // The stage really draws the puppet (pixels differ from the backdrop in the middle).
  const drawn = await page.evaluate(() => {
    const c = document.getElementById('csCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let changed = 0; const bg = [d[0], d[1], d[2]];
    for (let i = 0; i < d.length; i += 4 * 97) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) changed++;
    return changed;
  });
  expect(drawn).toBeGreaterThan(50);

  // A move plays.
  await page.locator('#csMove').selectOption('jump');
  await page.waitForTimeout(300);

  // Actions: a new action has two steps; make it short and silent, then record it.
  await page.locator('.cs-tab[data-tab="actions"]').click();
  await page.locator('#csActNew').click();
  await expect(page.locator('.cs-step')).toHaveCount(2);
  for (const i of [0, 1]) {
    await page.locator(`.cs-step[data-i="${i}"] [data-k="line"]`).fill('');
    await page.locator(`.cs-step[data-i="${i}"] [data-k="seconds"]`).fill('0.5');
  }
  await page.locator('#csActRec').click();
  await expect(page.locator('#csStatus')).toContainText('Saved to the Library', { timeout: 30_000 });

  const chars = await (await request.get('/api/characters')).json();
  const robot = chars.find(c => c.name === 'Studio Robot');
  expect(robot.puppet.head).toBe('screen');
  expect(robot.actions[0].steps).toHaveLength(2);
  const lib = await (await request.get('/api/media')).json();
  const clip = lib.find(m => m.provenance && m.provenance.generator === 'character-studio');
  expect(clip.kind).toBe('video');
  expect(clip.originalName).toContain('Studio Robot');
});

test('Character Studio 3D: design face, hair, body and costume, pose joints and save a pose', async ({ page, request }) => {
  test.setTimeout(360_000); // WebGL runs in software in headless Chromium
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="charstudio"]').click();
  await page.locator('#csNew').click();
  await expect(page.locator('#csName')).toHaveValue('New character');
  await page.locator('#csName').fill('Studio 3D');
  await page.locator('[data-mode="3d"]').click();
  await expect(page.locator('#csCanvas.cs3d')).toBeVisible();
  await expect(page.locator('.cs-tab[data-tab="pose"]')).toBeVisible();

  // Body: start from a look; Hair: pick a style; Face: change the eyes; Costume: add extras.
  await page.locator('[data-look3="gardener"]').click();
  await page.locator('.cs-tab[data-tab="hair"]').click();
  await page.locator('[data-hair="ponytail"]').click();
  await page.locator('.cs-tab[data-tab="face"]').click();
  await page.locator('[data-r="face.eyeShape"]').selectOption('almond');
  await page.locator('[data-r="face.earShape"]').selectOption('pointed');
  await page.locator('[data-expr="happy"]').click();
  await page.locator('.cs-tab[data-tab="costume"]').click();
  await page.locator('[data-r="costume.top"]').selectOption('kurta');
  await page.locator('[data-ex3="glasses"]').check();

  // Pose: a ready pose, then a single joint, then save it.
  await page.locator('.cs-tab[data-tab="pose"]').click();
  await page.locator('[data-pose="wave"]').click();
  await page.locator('#cs3Joint').selectOption('head');
  await page.locator('[data-ja="1"]').evaluate(el => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('[data-jv="1"]')).toHaveText('30°');
  await page.locator('#cs3PoseName').fill('Hello wave');
  await page.locator('#cs3PoseSave').click();
  await expect(page.locator('[data-papply]')).toHaveText('Hello wave');
  await page.waitForTimeout(400);

  // The WebGL stage really draws something.
  const drawn = await page.evaluate(() => {
    const src = document.getElementById('csCanvas'), c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const x = c.getContext('2d'); x.drawImage(src, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
    let changed = 0; for (let i = 0; i < d.length; i += 4 * 101) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 40) changed++;
    return changed;
  });
  expect(drawn).toBeGreaterThan(40);
  await page.screenshot({ path: 'test-results/character-studio-3d.png' });

  const all3d = await (await request.get('/api/characters')).json();
  const robot = all3d.find(c => c.name === 'Studio 3D');
  expect(robot.stage).toBe('3d');
  expect(robot.rig3d.hair.style).toBe('ponytail');
  expect(robot.rig3d.face.eyeShape).toBe('almond');
  expect(robot.rig3d.costume.extras).toContain('glasses');
  expect(robot.rig3d.poses[0].name).toBe('Hello wave');
  expect(robot.rig3d.poses[0].joints.head[1]).toBe(30);
  expect(robot.rig3d.poses[0].joints.upperArmR[2]).toBe(140);

  // Actions can use the saved pose.
  await page.locator('.cs-tab[data-tab="actions"]').click();
  await page.locator('#csActNew').click();
  await page.locator('.cs-step[data-i="0"] [data-k="move"]').selectOption({ label: 'Pose: Hello wave' });
  await page.locator('#csSave').click();
  await expect(page.locator('#csSave')).toHaveText('Saved');
  const again = (await (await request.get('/api/characters')).json()).find(c => c.name === 'Studio 3D');
  expect(again.actions[0].steps[0]).toMatchObject({ move: 'pose', poseId: again.rig3d.poses[0].id });

  // Body systems: each view draws, and an action step can switch the view.
  await page.locator('.cs-tab[data-tab="systems"]').click();
  for (const sys of ['digestive', 'circulatory', 'respiratory', 'excretory', 'nervous', 'skeletal', 'endocrine', 'reproductive', 'organs']) {
    await page.locator(`[data-sys="${sys}"]`).click();
    await expect(page.locator(`[data-sys="${sys}"]`)).toHaveClass(/btn-amber/);
  }
  await page.locator('[data-sys="reproductive"]').click();
  await page.locator('#cs3Var').selectOption('male');
  await page.locator('[data-sys="digestive"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/character-studio-systems.png' });
  await page.locator('.cs-tab[data-tab="actions"]').click();
  await page.locator('.cs-step[data-i="0"] [data-k="view"]').selectOption('circulatory');
  await page.locator('#csSave').click();
  await expect(page.locator('#csSave')).toHaveText('Saved');
  const viewSaved = (await (await request.get('/api/characters')).json()).find(c => c.name === 'Studio 3D');
  expect(viewSaved.actions[0].steps[0].view).toBe('circulatory');
  expect(errors).toEqual([]);
});

test('Character Studio: Animate timeline with keys and IK, glTF export, capture tab and lip-sync engine', async ({ page, request }) => {
  test.setTimeout(360_000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="charstudio"]').click();
  await page.locator('#csNew').click();
  await expect(page.locator('#csName')).toHaveValue('New character');
  await page.locator('#csName').fill('Timeline 3D');
  await page.locator('[data-mode="3d"]').click();
  await expect(page.locator('#csCanvas.cs3d')).toBeVisible();

  // Pose tab: hand reach IK fills the arm joints; save a pose.
  await page.locator('.cs-tab[data-tab="pose"]').click();
  await page.locator('#ikFwd').evaluate(el => { el.value = '0.45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#cs3Joint').selectOption('forearmR');
  await expect(page.locator('[data-ja="0"]')).not.toHaveValue('0');
  await page.locator('#cs3PoseName').fill('Reach');
  await page.locator('#cs3PoseSave').click();
  await expect(page.locator('[data-papply]')).toHaveText('Reach');

  // Animate: new animation, keys on several layers, IK feet.
  await page.locator('.cs-tab[data-tab="anim"]').click();
  await page.locator('#csAnimNew').click();
  await expect(page.locator('.cs-key-body')).toHaveCount(1);
  const lane = page.locator('.cs-tl-lane[data-row="body"]');
  const box = await lane.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.locator('#csAddSaved').selectOption({ label: 'Reach' });
  await page.locator('#csAddFace').selectOption('happy');
  await page.locator('#csAddLine').fill('Hello there');
  await page.locator('#csAddVoice').click();
  await expect(page.locator('.cs-key-body')).toHaveCount(2);
  await expect(page.locator('.cs-key-face')).toHaveCount(1);
  await expect(page.locator('.cs-key-voice')).toHaveCount(1);
  await page.locator('#csSave').click();
  await expect(page.locator('#csSave')).toHaveText('Saved');
  const ch = (await (await request.get('/api/characters')).json()).find(c => c.name === 'Timeline 3D');
  const anim = ch.rig3d.anims[0];
  expect(anim.ik.feet).toBe(true);
  expect(anim.tracks.body[1].poseId).toBe(ch.rig3d.poses[0].id);
  expect(anim.tracks.body[1].t).toBeGreaterThan(2.5); expect(anim.tracks.body[1].t).toBeLessThan(3.5);
  expect(anim.tracks.voice[0].line).toBe('Hello there');

  // Export: the .glb (with baked animation) lands in Maataa Library/Exports; FBX explains it needs Blender.
  await page.locator('#csExpGlb').click();
  await expect(page.locator('#csStatus')).toContainText('Maataa Library/Exports', { timeout: 120_000 });
  await expect(page.locator('#csStatus')).toContainText('animation tracks');
  await page.locator('#csExpFbx').click();
  await expect(page.locator('#csStatus')).toContainText(/Blender|\.fbx/, { timeout: 120_000 });

  // The timeline engine evaluates poses and IK; the viseme engine aligns a line.
  const probe = await page.evaluate(async () => {
    const M = await import('/cs3d.js'), V = await import('/cs-visemes.js');
    const anim = { duration: 2, ik: { feet: true }, tracks: { body: [{ t: 0, pose: { joints: { head: [0, 0, 0] }, root: { lift: 0 } } }, { t: 2, pose: { joints: { head: [0, 40, 0] }, root: { lift: -0.4 } } }] } };
    const mid = M.evalAnim(anim, 1, {});
    const s = new Float32Array(24000); for (let i = 4800; i < 19200; i++) s[i] = 0.3 * Math.sin(i / 10);
    const tr = V.align(V.fromText('नमस्ते'), s, 24000);
    return { head: mid.joints.head[1], lift: mid.root.lift, ik: mid.root.ikFeet, events: tr.events.length, first: tr.events[0].t0 };
  });
  expect(probe.head).toBeCloseTo(20, 0); expect(probe.lift).toBeCloseTo(-0.2, 1); expect(probe.ik).toBe(true);
  expect(probe.events).toBeGreaterThan(4); expect(probe.first).toBeCloseTo(0.2, 1);

  // Capture: without the models it points to Setup → Install.
  await page.locator('.cs-tab[data-tab="capture"]').click();
  await expect(page.locator('#csCapInstall')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Character Studio: scan a picture into the 3D character and make a 3D mesh', async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="charstudio"]').click();
  await page.locator('#csNew').click();
  await expect(page.locator('#csName')).toHaveValue('New character');
  await page.locator('#csName').fill('Scanned kid');
  await page.locator('[data-mode="3d"]').click();
  await expect(page.locator('#csCanvas.cs3d')).toBeVisible();
  await page.locator('#csSave').click();
  await expect(page.locator('#csSave')).toHaveText('Saved');

  // A drawn figure on white: dark hair, brown face, green top, bare legs, black shoes.
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 400; const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 200, 400);
    x.fillStyle = '#20180f'; x.fillRect(70, 10, 60, 25); x.fillStyle = '#b07850'; x.fillRect(70, 35, 60, 60);
    x.fillStyle = '#2e9a4a'; x.fillRect(50, 95, 100, 140); x.fillStyle = '#b07850'; x.fillRect(65, 235, 70, 140); x.fillStyle = '#111111'; x.fillRect(65, 375, 70, 20);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('.cs-tab[data-tab="scan"]').click();
  await page.locator('#csScanFile').setInputFiles({ name: 'drawn kid.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  await expect(page.locator('#csScanPrev')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#csScanGo')).toBeEnabled();
  await page.locator('#csScanGo').click();
  await expect(page.locator('#csScanApply')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#csScanState')).toContainText('No vision model');
  await page.locator('#csScanApply').click();
  await page.locator('#csSave').click();
  await expect(page.locator('#csSave')).toHaveText('Saved');
  let ch = (await (await request.get('/api/characters')).json()).find(c => c.name === 'Scanned kid');
  const near = (a, b) => { const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); const [x, y] = [p(a), p(b)]; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 30; };
  expect(near(ch.rig3d.costume.topColor, '#2e9a4a')).toBe(true);
  expect(near(ch.rig3d.body.skin, '#b07850')).toBe(true);
  expect(near(ch.rig3d.hair.color, '#20180f')).toBe(true);
  expect(ch.rig3d.costume.bottom).toBe('shorts');
  expect(ch.scanMediaId).toBeTruthy();

  // Make a 3D mesh (TripoSR is replaced by a fixture in tests); it appears beside the character.
  await page.locator('#csMeshGo').click();
  await expect(page.locator('[data-mshow]')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('[data-mside]')).toHaveText('Hide', { timeout: 30_000 });
  ch = (await (await request.get('/api/characters')).json()).find(c => c.name === 'Scanned kid');
  expect(ch.meshes.length).toBe(1);
  const glb = await request.get('/api/characters/meshes/' + ch.meshes[0].file);
  expect(glb.ok()).toBe(true); expect((await glb.body()).subarray(0, 4).toString()).toBe('glTF');
  await page.locator('[data-mshow]').click();
  await expect(page.locator('#csStatus')).toContainText('triangles');
  await page.locator('[data-mexp]').click();
  await expect(page.locator('#toast')).toContainText('Exports', { timeout: 20_000 });
  expect((await request.get('/api/characters/meshes/..%2Fnova.db')).status()).toBe(404);
  expect(errors).toEqual([]);
});

test('Character Studio scenes: Mira & Inchi demo, edit beats, lines and camera, record, SRT, script import and drawn poses', async ({ page, request }) => {
  test.setTimeout(360_000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.locator('.nav-item[data-view="charstudio"]').click();
  await page.locator('[data-csmode="scenes"]').click();
  await page.locator('#scStarter').click();
  await expect(page.locator('#scName')).toHaveValue('Mira & Inchi · The runaway robot', { timeout: 30_000 });
  // the stage draws the courtyard and the drawn characters
  await page.locator('#scScrub').evaluate(el => { el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(1500);
  const varied = await page.evaluate(() => { const c = document.getElementById('scCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 211) seen.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4)); return seen.size; });
  expect(varied).toBeGreaterThan(150);
  if (process.env.SCENE_SHOTS) await page.locator('.sc-stage').screenshot({ path: process.env.SCENE_SHOTS + '/stage.png' });
  // beats: split at the playhead
  await page.locator('[data-sctab="beats"]').click();
  const before = await page.locator('[data-beat]').count();
  await page.locator('#scSplit').click();
  await expect(page.locator('[data-beat]')).toHaveCount(before + 1);
  // lines: add one at the playhead
  await page.locator('[data-sctab="lines"]').click();
  await page.locator('#scAddLn').click();
  await expect(page.locator('[data-lndel]')).toHaveCount(5);
  // camera: frame Inchi in the last shot
  await page.locator('[data-sctab="camera"]').click();
  await page.locator('[data-sh="2"][data-f="frame"]').selectOption({ label: 'Inchi' });
  await page.locator('#scSave').click(); await expect(page.locator('#scSave')).toHaveText('Saved');
  let sc = (await (await request.get('/api/scenes')).json()).find(s => s.name.startsWith('Mira & Inchi'));
  expect(sc.beats.length).toBe(before + 1); expect(sc.dialogue.length).toBe(5); expect(sc.shots[2].zoom).toBe(1.8);
  // render: 9:16, record to the Library (no Kokoro here: captions only)
  await page.locator('[data-sctab="render"]').click();
  await page.locator('[data-pf="aspect"]').selectOption('9:16');
  await page.locator('#scRec').click();
  await expect(page.locator('#scRecState')).toContainText('Saved to the Library', { timeout: 120_000 });
  const vids = (await (await request.get('/api/media')).json()).filter(m => m.kind === 'video' && m.provenance?.sceneId === sc.id);
  expect(vids.length).toBe(1);
  if (process.env.SCENE_SHOTS) require('fs').writeFileSync(process.env.SCENE_SHOTS + '/scene.mp4', await (await request.get('/api/media/' + vids[0].id + '/file')).body());
  const srt = await request.get('/api/scenes/' + sc.id + '/srt?speakers=1');
  expect(await srt.text()).toContain('Inchi: आई! आई!');
  // script import (pasted)
  await page.locator('[data-sctab="script"]').click();
  await page.locator('#scScriptText').fill('INT. GARDEN\nMira: इंची, कहाँ हो?\nInchi: यहाँ हूँ!\nDadi: खाना तैयार है।');
  await page.locator('#scImport').click();
  await expect(page.locator('#scName')).toHaveValue('Pasted script · 1', { timeout: 20_000 });
  await expect(page.locator('#scStatus')).toContainText('Dadi');
  sc = (await (await request.get('/api/scenes')).json()).find(s => s.name === 'Pasted script · 1');
  expect(sc.actors.map(a => a.label)).toEqual(['Mira', 'Inchi', 'Dadi']); expect(sc.actors[2].characterId).toBe(null);
  // drawn poses: cut a 2×1 sheet into two poses for a new character
  await page.locator('[data-csmode="characters"]').click();
  await page.locator('#csNew').click(); await expect(page.locator('#csName')).toHaveValue('New character');
  await page.locator('.cs-tab[data-tab="cutouts"]').click();
  const sheet = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#e33'; x.fillRect(60, 40, 80, 150); x.fillStyle = '#33e'; x.fillRect(250, 20, 100, 170); return c.toDataURL('image/png').split(',')[1]; });
  await page.locator('#cuFile').setInputFiles({ name: 'sheet.png', mimeType: 'image/png', buffer: Buffer.from(sheet, 'base64') });
  await page.locator('#cuCols').fill('2'); await page.locator('#cuRows').fill('1'); await page.locator('#cuRows').dispatchEvent('change');
  const g = await page.locator('#cuGrid').boundingBox();
  await page.mouse.click(g.x + g.width * 0.25, g.y + g.height / 2); await page.mouse.click(g.x + g.width * 0.75, g.y + g.height / 2);
  await page.locator('[data-cell="2"]').fill('jump');
  await page.locator('#cuGo').click();
  await expect(page.locator('.sc-cut')).toHaveCount(2, { timeout: 20_000 });
  await page.locator('#csSave').click(); await expect(page.locator('#csSave')).toHaveText('Saved');
  const ch = (await (await request.get('/api/characters')).json()).find(c => c.name === 'New character' && (c.cutouts || []).length);
  expect(ch.cutouts.map(c => c.name)).toEqual(['run', 'jump']);
  const cell = await request.get('/api/media/' + ch.cutouts[1].frames[0] + '/file');
  expect(cell.ok()).toBe(true);
  expect(errors).toEqual([]);
});
