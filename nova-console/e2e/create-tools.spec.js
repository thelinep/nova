const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function ffmpeg() { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch (_) { return null; } }
function fixture(name, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-fx-'));
  const f = path.join(dir, name);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, f]);
  return { name, mimeType: name.endsWith('.png') ? 'image/png' : name.endsWith('.wav') ? 'audio/wav' : 'video/mp4', buffer: fs.readFileSync(f) };
}
async function openLibrary(page) {
  await page.locator('.nav-item[data-media-tab="library"]').click();
  await expect(page.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
}
async function upload(page, file) {
  await openLibrary(page);
  await page.getByLabel('Upload images, audio or video').setInputFiles(file);
  await expect(page.locator('.media-item strong', { hasText: file.name }).first()).toBeVisible();
}
async function actions(page, name) { await page.locator('.media-item', { hasText: name }).first().locator('summary', { hasText: 'Actions' }).click(); }

test.describe('Create tools', () => {
  test.skip(!ffmpeg(), 'needs ffmpeg');

  test('the Create group opens each Media tab and the new views', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    for (const [tab, heading] of [['image', 'Generate an image'], ['video', 'Animate stills'], ['audio', 'Voice, sound effects, music']]) {
      await page.locator(`.nav-item[data-media-tab="${tab}"]`).click();
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.locator(`.nav-item[data-media-tab="${tab}"]`)).toHaveClass(/active/);
    }
    await expect(page.getByLabel('Style or character LoRA')).toBeHidden();
    await page.locator('.nav-item[data-media-tab="image"]').click();
    await expect(page.getByLabel('Style or character LoRA')).toBeVisible();
    await page.locator('.nav-item[data-view="boards"]').click();
    await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();
    await page.locator('.nav-item[data-view="timeline"]').click();
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await page.locator('.nav-item[data-media-tab="video"]').click();
    await expect(page.getByRole('button', { name: /Make video from prompt|Animate first shot/ })).toBeVisible();
  });

  test('image actions: menu, mask brush, expand and a real ffmpeg upscale', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await upload(page, fixture('street-still.png', ['-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1']));
    await actions(page, 'street-still.png');
    for (const item of ['Edit area…', 'Remove object…', 'Expand background…', 'Upscale…', 'Add to board…', 'Add to timeline…', 'Attach to chat']) await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Remove object…' }).click();
    const canvas = page.getByLabel('Paint mask');
    await expect(canvas).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('Paint over the area first');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 90, box.y + 60, { steps: 5 }); await page.mouse.up();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('#toast')).toContainText(/ComfyUI|not reachable|not running/);
    await page.getByRole('button', { name: 'Close' }).first().click();
    await actions(page, 'street-still.png');
    await page.getByRole('menuitem', { name: 'Upscale…' }).click();
    await expect(page.getByText(/high-quality resize with ffmpeg/)).toBeVisible();
    await page.getByRole('button', { name: 'Upscale', exact: true }).click();
    await expect(page.locator('.media-item strong', { hasText: 'street-still (upscaled 2x)' }).first()).toBeVisible({ timeout: 20000 });
  });

  test('audio actions: enhance speech makes a new item; translate asks for a language and voice', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await upload(page, fixture('location-sound.wav', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-f', 'lavfi', '-i', 'anoisesrc=d=2:a=0.05', '-filter_complex', 'amix=inputs=2']));
    await actions(page, 'location-sound.wav');
    await page.getByRole('menuitem', { name: 'Enhance speech…' }).click();
    await page.getByLabel('Clean-up strength').selectOption('strong');
    await page.getByRole('button', { name: 'Enhance', exact: true }).click();
    await expect(page.locator('.media-item strong', { hasText: 'location-sound (speech enhanced)' }).first()).toBeVisible({ timeout: 20000 });
    await actions(page, 'location-sound.wav');
    await page.getByRole('menuitem', { name: 'Translate…' }).click();
    await expect(page.getByLabel('Translate into')).toHaveValue('hi');
    await expect(page.locator('#actionModal').getByLabel('Spoken language')).toHaveValue('en');
    await expect(page.getByText(/translate from English only/)).toBeVisible();
    await expect(page.getByLabel('Dub voice')).toBeVisible();
    await expect(page.getByLabel('Translation output').locator('option')).toHaveCount(1); // audio: dub only
  });

  test('boards: create, add a note, a colour and a library image; it survives a reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await upload(page, fixture('look-ref.png', ['-f', 'lavfi', '-i', 'testsrc=size=320x240', '-frames:v', '1']));
    await page.locator('.nav-item[data-view="boards"]').click();
    await page.getByRole('button', { name: 'New board' }).first().click();
    await page.getByLabel('Board name').fill('Asha look book');
    await page.getByRole('button', { name: 'Note' }).click();
    await page.getByRole('button', { name: /From library/ }).click();
    await page.locator('.pick-item', { hasText: 'look-ref.png' }).first().click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.board-item')).toHaveCount(2);
    const note = page.locator('.board-note textarea');
    await note.dblclick(); await note.fill('Warm, dusty, 1970s Bombay');
    const img = page.locator('.board-media').first();
    const b = await img.boundingBox();
    await page.mouse.move(b.x + 40, b.y + 40); await page.mouse.down(); await page.mouse.move(b.x + 240, b.y + 140, { steps: 6 }); await page.mouse.up();
    await expect(page.locator('#boardSaved')).toHaveText('Saved', { timeout: 5000 });
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.locator('.nav-item[data-view="boards"]').click();
    await expect(page.locator('.board-link', { hasText: 'Asha look book' })).toBeVisible();
    await expect(page.locator('.board-note textarea')).toHaveValue('Warm, dusty, 1970s Bombay');
    await expect(page.locator('.board-item')).toHaveCount(2);
    await page.getByRole('button', { name: 'Save as image' }).click();
    await expect(page.locator('#toast')).toContainText('Board saved to the library');
  });

  test('timeline: add a still, a clip and music, trim, and export a real MP4', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await upload(page, fixture('tl-still.png', ['-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1']));
    await upload(page, fixture('tl-clip.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac']));
    await upload(page, fixture('tl-theme.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6']));
    await actions(page, 'tl-still.png');
    await page.getByRole('menuitem', { name: 'Add to timeline…' }).click();
    await page.getByLabel('New timeline name').fill('Sc 12 Marine Drive');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('Added to Sc 12 Marine Drive');
    await page.locator('.nav-item[data-view="timeline"]').click();
    await expect(page.getByLabel('Timeline name')).toHaveValue('Sc 12 Marine Drive');
    await page.getByRole('button', { name: 'Add clips' }).click();
    await page.locator('.pick-item', { hasText: 'tl-clip.mp4' }).first().click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Add sound' }).click();
    await page.locator('.pick-item', { hasText: 'tl-theme.wav' }).first().click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.tl-block.tl-video')).toHaveCount(2);
    await expect(page.locator('.tl-block.tl-music')).toHaveCount(1);
    await page.locator('.tl-block.tl-video').first().click();
    const insp = page.locator('#tlInspector');
    await insp.getByLabel('Seconds').fill('1.5'); await insp.getByLabel('Seconds').press('Enter');
    await expect(page.locator('.tl-total')).toContainText('3.5');
    await page.locator('.tl-block.tl-music').click();
    await insp.getByLabel('Level').fill('0.4'); await insp.getByLabel('Level').press('Enter');
    await expect(page.locator('#tlSaved')).toHaveText('Saved', { timeout: 5000 });
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await expect(page.locator('#timelineView video')).toBeVisible({ timeout: 30000 });
  });

  test('chat: "make an image of…" becomes a card to confirm instead of a chat reply', async ({ page }) => {
    await page.goto('/');
    await page.locator('#newSessionBtn').click();
    await page.locator('#composer').fill('Make an image of a rain-soaked Mumbai street at dusk, neon reflections');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.msg.assistant .bubble').last()).toContainText('I can make an image on this Mac');
    await expect(page.getByRole('button', { name: 'Generate', exact: true }).last()).toBeVisible();
    await page.getByRole('button', { name: 'Generate', exact: true }).last().click();
    await expect(page.locator('.create-card').last()).toContainText(/failed|ComfyUI/, { timeout: 15000 });
    await page.locator('#composer').fill('/song two strangers share an umbrella in the first monsoon rain');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.msg.assistant .bubble').last()).toContainText('a song');
    await page.getByRole('button', { name: 'Open in Media' }).last().click();
    await expect(page.getByLabel('Song idea')).toHaveValue(/two strangers share an umbrella/);
  });
});
