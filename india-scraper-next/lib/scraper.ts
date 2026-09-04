import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import db from './db';
import { extractWithOllama } from './ollamaHelper';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ScrapedItem {
  business_name: string;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
}

function insertRecords(category: string, districtId: number, item: ScrapedItem): Promise<void> {
  // Normalize phone to '' so the UNIQUE(category, district_id, business_name, phone)
  // constraint actually dedupes rows where phone is missing (SQLite NULLs never
  // compare equal, so NULL phones would bypass the constraint entirely).
  const phoneKey = (item.phone ?? '').trim();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `INSERT INTO scraped_data 
          (category, district_id, business_name, contact_person, phone, address, website)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [category, districtId, item.business_name, item.contact_person, item.phone, item.address, item.website],
        (err) => { if (err) reject(err); }
      );

      db.run(
        `INSERT INTO refined_data 
          (category, district_id, business_name, contact_person, phone, address, website)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(category, district_id, business_name, phone) DO UPDATE SET
           contact_person = excluded.contact_person,
           address = excluded.address,
           website = excluded.website,
           last_updated = CURRENT_TIMESTAMP`,
        [category, districtId, item.business_name, item.contact_person, phoneKey, item.address, item.website],
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
  });
}

export async function scrapeDistrict(
  category: string,
  districtName: string,
  districtId: number,
  retries: number = parseInt(process.env.RETRY_ATTEMPTS || '3')
): Promise<number> {
  let attempt = 0;
  while (attempt < retries) {
    try {
      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      await page.setViewport({ width: 1280, height: 800 });

      const searchQuery = `${category} in ${districtName}, India`;
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => null);

      const results: ScrapedItem[] = [];
      const seen = new Set<string>();
      let previousHeight = 0;
      let scrollAttempts = 0;
      const maxScrolls = 10;

      while (scrollAttempts < maxScrolls) {
        const items = await page.$$('div[role="article"]');
        for (const item of items) {
          try {
            const name = await item.$eval('div.fontHeadlineSmall', (el: Element) => (el as HTMLElement).innerText).catch(() => '');
            const address = await item.$eval('div[data-item-id="address"]', (el: Element) => (el as HTMLElement).innerText).catch(() => '');
            const phone = await item.$eval('div[data-item-id="phone"]', (el: Element) => (el as HTMLElement).innerText).catch(() => '');
            const website = await item.$eval('div[data-item-id="website"]', (el: Element) => (el as HTMLElement).innerText).catch(() => '');

            const combinedText = `${name} ${address} ${phone} ${website}`;
            const enriched = await extractWithOllama(combinedText);

            const record: ScrapedItem = {
              business_name: name || enriched?.company_name || '',
              contact_person: enriched?.contact_person || null,
              phone: phone || enriched?.phone || null,
              address: address || enriched?.address || null,
              website: website || null,
            };

            // Dedup key tolerant of NULL phone (SQLite treats NULLs as distinct,
            // which would otherwise let the same business insert repeatedly).
            const key = `${record.business_name.trim().toLowerCase()}|${(record.phone || '').trim()}`;
            if (!record.business_name || seen.has(key)) continue;
            seen.add(key);
            results.push(record);
          } catch (e) { /* skip */ }
        }

        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await sleep(2000 + Math.random() * 1000);
        const newHeight = Number(await page.evaluate('document.body.scrollHeight'));
        if (newHeight === previousHeight) break;
        previousHeight = newHeight;
        scrollAttempts++;
      }

      await browser.close();

      for (const item of results) {
        await insertRecords(category, districtId, item);
      }
      return results.length;
    } catch (error) {
      attempt++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Scraping ${districtName} failed (attempt ${attempt}):`, message);
      if (attempt < retries) {
        const delay = parseInt(process.env.RETRY_DELAY || '2000') * Math.pow(2, attempt - 1);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  return 0;
}
