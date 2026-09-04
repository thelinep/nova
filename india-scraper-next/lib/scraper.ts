import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import db from './db';
import { extractWithOllama } from './ollamaHelper';
import fs from 'fs';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function findSystemChrome(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium');
  }
  return candidates.find(p => fs.existsSync(p));
}

interface ScrapedItem {
  business_name: string;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
  rating: string | null;
  reviews: string | null;
  maps_url: string | null;
  latitude: number | null;
  longitude: number | null;
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
          (category, district_id, business_name, contact_person, phone, address, website,
           rating, reviews, maps_url, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [category, districtId, item.business_name, item.contact_person, item.phone, item.address, item.website,
         item.rating, item.reviews, item.maps_url, item.latitude, item.longitude],
        (err) => { if (err) reject(err); }
      );

      db.run(
        `INSERT INTO refined_data 
          (category, district_id, business_name, contact_person, phone, address, website,
           rating, reviews, maps_url, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(category, district_id, business_name, phone) DO UPDATE SET
           contact_person = excluded.contact_person,
           address = excluded.address,
           website = excluded.website,
           rating = excluded.rating,
           reviews = excluded.reviews,
           maps_url = excluded.maps_url,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           last_updated = CURRENT_TIMESTAMP`,
        [category, districtId, item.business_name, item.contact_person, phoneKey, item.address, item.website,
         item.rating, item.reviews, item.maps_url, item.latitude, item.longitude],
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
      const executablePath = findSystemChrome();
      const launchOptions: any = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      };
      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }
      const browser = await puppeteer.launch(launchOptions);
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1280, height: 800 });

      const searchQuery = `${category} in ${districtName}, India`;
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => null);

      // Scroll the results feed until no new listings appear.
      let previousCount = 0;
      let unchangedRounds = 0;
      for (let i = 0; i < 30 && unchangedRounds < 3; i++) {
        const state = await page.evaluate(() => {
          const feed = document.querySelector('[role="feed"]');
          if (!feed) return { count: document.querySelectorAll('div[role="article"]').length, height: 0 };
          feed.scrollTop = feed.scrollHeight;
          return { count: feed.querySelectorAll('div[role="article"]').length, height: feed.scrollHeight };
        });
        await sleep(1800);
        const currentCount = await page.$$eval('div[role="article"]', items => items.length);
        if (currentCount <= previousCount && state.height === 0) unchangedRounds++;
        else if (currentCount <= previousCount) unchangedRounds++;
        else unchangedRounds = 0;
        previousCount = currentCount;
      }

      // Extract listings using the same robust selectors as the working scrapper.js.
      const rawItems = await page.evaluate(() => {
        const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() || '';
        const results: Array<{
          business_name: string;
          address: string;
          rating: string;
          reviews: string;
          phone: string;
          website: string | null;
          maps_url: string | null;
          latitude: number | null;
          longitude: number | null;
        }> = [];
        const items = document.querySelectorAll('div[role="article"]');
        items.forEach(item => {
          const nameLink = item.querySelector('a.hfpxzc[aria-label]');
          const business_name = nameLink?.getAttribute('aria-label') || text(item.querySelector('.fontHeadlineSmall'));
          if (!business_name) return;

          const ratingElement = item.querySelector('[role="img"][aria-label*="stars"], .MW4etd');
          const ratingLabel = ratingElement?.getAttribute('aria-label') || '';
          const ratingMatch = ratingLabel.match(/([0-5](?:\.\d)?)\s*stars?/i);
          const rating = ratingMatch ? ratingMatch[1] : text(item.querySelector('.MW4etd'));

          const reviewElement = item.querySelector('[aria-label*="reviews"], .UY7F9');
          const reviewLabel = reviewElement?.getAttribute('aria-label') || text(reviewElement);
          const reviewMatch = reviewLabel.match(/([\d,]+)\s*reviews?/i);
          const reviews = reviewMatch ? reviewMatch[1].replace(/,/g, '') : reviewLabel;

          const detailRows = [...item.querySelectorAll('.W4Efsd')]
            .map(row => text(row))
            .filter(Boolean);
          const detailParts = detailRows
            .flatMap(row => row.split('·').map(value => value.trim()))
            .filter(value => value && value !== rating && !/^(open|closed|temporarily closed)/i.test(value) && !/^\+?\d[\d\s().-]{7,}$/.test(value));
          const phone = detailParts
            .find(value => /^\+?[\d][\d\s().-]{7,}$/.test(value)) || '';
          const addressCandidates = detailParts.filter(value => value !== phone && !/^(wedding planner|event planner|event management company)$/i.test(value));
          const address = addressCandidates[addressCandidates.length - 1] || '';
          const website = (item.querySelector('a[data-value="Website"]') as HTMLAnchorElement)?.href || null;
          const href = (nameLink as HTMLAnchorElement)?.href || null;
          const coordinates = href?.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);

          results.push({
            business_name,
            address,
            rating,
            reviews,
            phone,
            website,
            maps_url: href,
            latitude: coordinates ? Number(coordinates[1]) : null,
            longitude: coordinates ? Number(coordinates[2]) : null,
          });
        });
        return [...new Map(results.map(item => [item.maps_url || item.business_name, item])).values()];
      });

      await browser.close();

      // Enrich and dedupe before persisting.
      const results: ScrapedItem[] = [];
      const seen = new Set<string>();
      for (const raw of rawItems) {
        const combinedText = `${raw.business_name} ${raw.address} ${raw.phone} ${raw.website || ''}`;
        const enriched = await extractWithOllama(combinedText);

        const record: ScrapedItem = {
          business_name: raw.business_name || enriched?.company_name || '',
          contact_person: enriched?.contact_person || null,
          phone: raw.phone || enriched?.phone || null,
          address: raw.address || enriched?.address || null,
          website: raw.website || null,
          rating: raw.rating || null,
          reviews: raw.reviews || null,
          maps_url: raw.maps_url || null,
          latitude: raw.latitude,
          longitude: raw.longitude,
        };

        const key = `${record.business_name.trim().toLowerCase()}|${(record.phone || '').trim()}`;
        if (!record.business_name || seen.has(key)) continue;
        seen.add(key);
        results.push(record);
      }

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
