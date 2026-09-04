import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import db from './db';

export async function seedDistricts() {
  const row = await new Promise<{ count: number }>((resolve) => {
    db.get('SELECT COUNT(*) as count FROM districts', (err, row) => resolve(row as any));
  });
  if (row.count > 0) {
    console.log('Districts already seeded.');
    return;
  }

  console.log('Seeding districts from Wikipedia...');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  await page.goto('https://en.wikipedia.org/wiki/List_of_districts_in_India', { waitUntil: 'networkidle2' });

  const districts = await page.evaluate(() => {
    const rows = document.querySelectorAll('table.wikitable tbody tr');
    const data: { name: string; state: string }[] = [];
    rows.forEach(row => {
      const cols = row.querySelectorAll('td');
      if (cols.length >= 2) {
        const name = cols[0].innerText.trim().replace(/\[.*\]/, '');
        const state = cols[1].innerText.trim();
        if (name && state) data.push({ name, state });
      }
    });
    return data;
  });

  await browser.close();

  const stmt = db.prepare('INSERT OR IGNORE INTO districts (name, state) VALUES (?, ?)');
  districts.forEach((d: { name: string; state: string }) => stmt.run(d.name, d.state));
  stmt.finalize();
  console.log(`Inserted ${districts.length} districts.`);
}
