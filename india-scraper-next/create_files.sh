#!/bin/bash
# This script creates all application source files (no npm install)

set -e

echo "Creating directory structure..."
mkdir -p app/api/start-scrape
mkdir -p 'app/api/job/[jobId]'
mkdir -p app/api/refined-results
mkdir -p app/api/history-results
mkdir -p app/api/districts
mkdir -p lib
mkdir -p types
mkdir -p __mocks__
mkdir -p __tests__
mkdir -p app

# ========== .env.local ==========
cat > .env.local <<'EOF'
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=llama3
CONCURRENCY=5
RETRY_ATTEMPTS=3
RETRY_DELAY=2000
USE_OLLAMA=true
EOF

# ========== tsconfig.json ==========
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2018",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
EOF

# ========== next.config.js ==========
cat > next.config.js <<'EOF'
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['sqlite3', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
};

module.exports = nextConfig;
EOF

# ========== tailwind.config.js ==========
cat > tailwind.config.js <<'EOF'
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: { extend: {} },
  plugins: [],
}
EOF

# ========== postcss.config.js ==========
cat > postcss.config.js <<'EOF'
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
EOF

# ========== types/globals.d.ts ==========
cat > types/globals.d.ts <<'EOF'
declare module '*.css';
EOF

# ========== app/globals.css ==========
cat > app/globals.css <<'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;
EOF

# ========== app/layout.tsx ==========
cat > app/layout.tsx <<'EOF'
import './globals.css';

export const metadata = {
  title: 'India Business Scraper',
  description: 'Scrape Google Maps across all Indian districts',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
EOF

# ========== app/page.tsx ==========
cat > app/page.tsx <<'EOF'
'use client';

import { useState, useEffect, useRef } from 'react';

type ViewMode = 'refined' | 'history';

interface ResultItem {
  id: number;
  category: string;
  district_id: number;
  district_name: string;
  business_name: string;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
  first_seen?: string;
  last_updated?: string;
  scraped_at?: string;
}

export default function Home() {
  const [category, setCategory] = useState('');
  const [view, setView] = useState<ViewMode>('refined');
  const [results, setResults] = useState<ResultItem[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ total: 0, completed: 0, status: 'idle' });
  const [loading, setLoading] = useState(false);
  const pollInterval = useRef<NodeJS.Timeout | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const fetchData = async () => {
    const endpoint = view === 'refined' ? '/api/refined-results' : '/api/history-results';
    const url = category ? `${endpoint}?category=${encodeURIComponent(category)}` : endpoint;
    try {
      const res = await fetch(url);
      const data = await res.json();
      setResults(data);
    } catch (error) {
      console.error('Fetch error:', error);
    }
  };

  const startScrape = async () => {
    if (!category) return alert('Enter a category');
    setLoading(true);
    try {
      const res = await fetch('/api/start-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setJobId(data.jobId);
      jobIdRef.current = data.jobId;
      setProgress({ total: data.total, completed: 0, status: 'running' });
      if (pollInterval.current) clearInterval(pollInterval.current);
      pollInterval.current = setInterval(checkProgress, 3000);
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const checkProgress = async () => {
    const currentJobId = jobIdRef.current;
    if (!currentJobId) return;
    try {
      const res = await fetch(`/api/job/${currentJobId}`);
      const data = await res.json();
      if (data.error) return;
      setProgress({ total: data.total, completed: data.completed, status: data.status });
      if (data.status === 'completed' || data.status === 'failed') {
        if (pollInterval.current) clearInterval(pollInterval.current);
        pollInterval.current = null;
        fetchData();
      }
    } catch (e) { /* ignore */ }
  };

  useEffect(() => {
    fetchData();
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, [view, category]);

  const getDateField = (item: ResultItem) => {
    return view === 'refined' ? item.last_updated : item.scraped_at;
  };

  return (
    <main className="container mx-auto p-4 max-w-6xl">
      <h1 className="text-3xl font-bold mb-2">🇮🇳 India Business Scraper</h1>
      <p className="text-gray-600 mb-4">Scrape Google Maps for any category across all Indian districts.</p>

      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          className="flex-1 min-w-[200px] p-2 border rounded"
          placeholder="e.g., plumbers, dentists"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <button
          onClick={startScrape}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Starting...' : 'Start Scraping'}
        </button>
      </div>

      {progress.status !== 'idle' && (
        <div className="mb-4 p-3 border rounded bg-gray-50">
          <div className="flex justify-between text-sm mb-1">
            <span>Progress: {progress.completed} / {progress.total}</span>
            <span>Status: <span className={`font-semibold ${progress.status === 'completed' ? 'text-green-600' : 'text-yellow-600'}`}>{progress.status}</span></span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2.5">
            <div className="bg-green-600 h-2.5 rounded-full transition-all" style={{ width: `${progress.total > 0 ? (progress.completed / progress.total * 100) : 0}%` }}></div>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setView('refined')}
          className={`px-3 py-1 rounded ${view === 'refined' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          Refined (Unique)
        </button>
        <button
          onClick={() => setView('history')}
          className={`px-3 py-1 rounded ${view === 'history' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          History (All)
        </button>
        <button onClick={fetchData} className="ml-auto px-3 py-1 bg-gray-200 rounded hover:bg-gray-300">
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full bg-white border">
          <thead>
            <tr className="bg-gray-100">
              <th className="py-2 px-3 border">District</th>
              <th className="py-2 px-3 border">Business</th>
              <th className="py-2 px-3 border">Contact Person</th>
              <th className="py-2 px-3 border">Phone</th>
              <th className="py-2 px-3 border">Address</th>
              <th className="py-2 px-3 border">Website</th>
              <th className="py-2 px-3 border">{view === 'refined' ? 'Last Updated' : 'Scraped At'}</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-4 text-gray-500">No data found</td></tr>
            ) : (
              results.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="py-1 px-3 border">{item.district_name}</td>
                  <td className="py-1 px-3 border">{item.business_name}</td>
                  <td className="py-1 px-3 border">{item.contact_person || '-'}</td>
                  <td className="py-1 px-3 border">{item.phone || '-'}</td>
                  <td className="py-1 px-3 border">{item.address || '-'}</td>
                  <td className="py-1 px-3 border">
                    {item.website ? <a href={item.website} target="_blank" className="text-blue-600 underline">Link</a> : '-'}
                  </td>
                  <td className="py-1 px-3 border text-sm">
                    {getDateField(item) ? new Date(getDateField(item)!).toLocaleString() : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-gray-500 mt-2">Showing latest {results.length} records</div>
    </main>
  );
}
EOF

# ========== lib/db.ts ==========
cat > lib/db.ts <<'EOF'
import sqlite3 from 'sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB error:', err.message);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS districts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      state TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scraped_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      district_id INTEGER,
      business_name TEXT,
      contact_person TEXT,
      phone TEXT,
      address TEXT,
      website TEXT,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (district_id) REFERENCES districts(id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scraped_category ON scraped_data(category)`);
  // Gracefully add columns if they don't exist yet (SQLite lacks IF NOT EXISTS for ADD COLUMN).
  const addColumn = (table: string, column: string, type: string) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err) => {
      if (err && !err.message.includes('duplicate column')) console.error(`ALTER ${table} ADD ${column} failed:`, err.message);
    });
  };
  addColumn('scraped_data', 'rating', 'TEXT');
  addColumn('scraped_data', 'reviews', 'TEXT');
  addColumn('scraped_data', 'maps_url', 'TEXT');
  addColumn('scraped_data', 'latitude', 'REAL');
  addColumn('scraped_data', 'longitude', 'REAL');

  db.run(`
    CREATE TABLE IF NOT EXISTS refined_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      district_id INTEGER,
      business_name TEXT,
      contact_person TEXT,
      phone TEXT,
      address TEXT,
      website TEXT,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category, district_id, business_name, phone) ON CONFLICT REPLACE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_refined_category ON refined_data(category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_refined_district ON refined_data(district_id)`);
  addColumn('refined_data', 'rating', 'TEXT');
  addColumn('refined_data', 'reviews', 'TEXT');
  addColumn('refined_data', 'maps_url', 'TEXT');
  addColumn('refined_data', 'latitude', 'REAL');
  addColumn('refined_data', 'longitude', 'REAL');
});

export default db;
EOF

# ========== lib/ollamaHelper.ts ==========
cat > lib/ollamaHelper.ts <<'EOF'
import axios from 'axios';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';

export async function extractWithOllama(text: string): Promise<any> {
  if (process.env.USE_OLLAMA === 'false') return null;
  try {
    const prompt = `
      Extract the following fields from the text below and return a valid JSON object with keys: "contact_person", "phone", "company_name", "address".
      If a field is not present, set it to null.
      Text: "${text}"
    `;
    const response = await axios.post(OLLAMA_URL, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
    });
    const raw = response.data.response;
    const jsonMatch = raw.match(/\{.*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (error) {
    console.error('Ollama extraction failed:', error);
    return null;
  }
}
EOF

# ========== lib/districtSeeder.ts ==========
cat > lib/districtSeeder.ts <<'EOF'
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
EOF

# ========== lib/scraper.ts ==========
cat > lib/scraper.ts <<'EOF'
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
EOF

# ========== lib/jobs.ts ==========
cat > lib/jobs.ts <<'EOF'
export interface Job {
  jobId: string;
  category: string;
  total: number;
  completed: number;
  status: 'running' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
}

const jobs: Record<string, Job> = {};

export function createJob(jobId: string, category: string, total: number): Job {
  const job: Job = { jobId, category, total, completed: 0, status: 'running', startTime: new Date().toISOString() };
  jobs[jobId] = job;
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs[jobId];
}

export function updateJob(jobId: string, updates: Partial<Job>): Job | undefined {
  const current = jobs[jobId];
  if (!current) return undefined;
  jobs[jobId] = { ...current, ...updates };
  return jobs[jobId];
}

export function incrementJobCompleted(jobId: string, by: number = 1): Job | undefined {
  const current = jobs[jobId];
  if (!current) return undefined;
  const completed = current.completed + by;
  const done = completed >= current.total;
  jobs[jobId] = {
    ...current,
    completed,
    ...(done ? { status: 'completed', endTime: new Date().toISOString() } : {}),
  };
  return jobs[jobId];
}

// Test helper
export function __clearJobs(): void {
  for (const key of Object.keys(jobs)) delete jobs[key];
}
EOF

# ========== app/api/start-scrape/route.ts ==========
cat > app/api/start-scrape/route.ts <<'EOF'
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { scrapeDistrict } from '@/lib/scraper';
import { createJob, incrementJobCompleted } from '@/lib/jobs';
import { seedDistricts } from '@/lib/districtSeeder';

export async function POST(request: NextRequest) {
  const { category } = await request.json();
  if (!category) {
    return NextResponse.json({ error: 'Category is required' }, { status: 400 });
  }

  // Get all districts
  const districts = await new Promise<any[]>((resolve, reject) => {
    db.all('SELECT * FROM districts', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

  if (districts.length === 0) {
    // If no districts, seed them first
    await seedDistricts();
    // Re-fetch
    const newDistricts = await new Promise<any[]>((resolve, reject) => {
      db.all('SELECT * FROM districts', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    if (newDistricts.length === 0) {
      return NextResponse.json({ error: 'No districts found' }, { status: 500 });
    }
    districts.push(...newDistricts);
  }

  const jobId = Date.now().toString();
  createJob(jobId, category, districts.length);

  // Start scraping in background (non-blocking)
  (async () => {
    const queue = [...districts];
    let index = 0;
    const concurrency = parseInt(process.env.CONCURRENCY || '5');

    async function worker() {
      while (index < queue.length) {
        const district = queue[index++];
        try {
          const count = await scrapeDistrict(category, district.name, district.id);
          console.log(`OK ${district.name}: ${count} results`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`FAIL ${district.name}:`, message);
        } finally {
          incrementJobCompleted(jobId, 1);
        }
      }
    }

    const workers = Array(Math.min(concurrency, districts.length)).fill(null).map(() => worker());
    await Promise.all(workers);
  })();

  return NextResponse.json({ jobId, total: districts.length, message: 'Scraping started' });
}
EOF

# ========== app/api/job/[jobId]/route.ts ==========
cat > app/api/job/[jobId]/route.ts <<'EOF'
import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  return NextResponse.json(job);
}
EOF

# ========== app/api/refined-results/route.ts ==========
cat > app/api/refined-results/route.ts <<'EOF'
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category');
  const district_id = searchParams.get('district_id');

  let sql = `
    SELECT r.*, d.name as district_name 
    FROM refined_data r 
    JOIN districts d ON r.district_id = d.id
  `;
  const params: any[] = [];
  const conditions: string[] = [];
  if (category) {
    conditions.push('r.category = ?');
    params.push(category);
  }
  if (district_id) {
    conditions.push('r.district_id = ?');
    params.push(parseInt(district_id));
  }
  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY r.last_updated DESC LIMIT 500';

  const rows = await new Promise<any[]>((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
  return NextResponse.json(rows);
}
EOF

# ========== app/api/history-results/route.ts ==========
cat > app/api/history-results/route.ts <<'EOF'
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category');
  const district_id = searchParams.get('district_id');

  let sql = `
    SELECT h.*, d.name as district_name 
    FROM scraped_data h 
    JOIN districts d ON h.district_id = d.id
  `;
  const params: any[] = [];
  const conditions: string[] = [];
  if (category) {
    conditions.push('h.category = ?');
    params.push(category);
  }
  if (district_id) {
    conditions.push('h.district_id = ?');
    params.push(parseInt(district_id));
  }
  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY h.scraped_at DESC LIMIT 1000';

  const rows = await new Promise<any[]>((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
  return NextResponse.json(rows);
}
EOF

# ========== app/api/districts/route.ts ==========
cat > app/api/districts/route.ts <<'EOF'
import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET() {
  const rows = await new Promise<any[]>((resolve, reject) => {
    db.all('SELECT id, name, state FROM districts ORDER BY name', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
  return NextResponse.json(rows);
}
EOF

# ========== jest.config.js ==========
cat > jest.config.js <<'EOF'
const nextJest = require('next/jest');

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files
  dir: './',
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.(test|spec).(ts|tsx)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '\\.(css|less|scss|sass)$': '<rootDir>/__mocks__/styleMock.js',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  collectCoverageFrom: [
    'lib/**/*.(ts|tsx)',
    'app/api/**/*.(ts|tsx)',
    '!**/*.d.ts',
  ],
};

module.exports = createJestConfig(customJestConfig);
EOF

# ========== jest.setup.ts ==========
cat > jest.setup.ts <<'EOF'
import '@testing-library/jest-dom';

// Polyfill Web APIs (Request/Response/fetch/headers) for Next.js route handlers
// running under jsdom, which doesn't expose them.
import { TextEncoder, TextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  (global as any).TextEncoder = TextEncoder;
  (global as any).TextDecoder = TextDecoder;
}

// Use Node 18+ built-in fetch/Request/Response if available; else leave undefined.
// jsdom doesn't define these, but Node's undici globals do.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const undici = require('undici');
  if (typeof global.Request === 'undefined') (global as any).Request = undici.Request;
  if (typeof global.Response === 'undefined') (global as any).Response = undici.Response;
  if (typeof global.Headers === 'undefined') (global as any).Headers = undici.Headers;
  if (typeof global.fetch === 'undefined') (global as any).fetch = undici.fetch;
} catch {
  // undici not available; Next's web spec extensions will still fail for Request,
  // so route tests should run in the node environment instead.
}
EOF

# ========== __mocks__/styleMock.js ==========
cat > __mocks__/styleMock.js <<'EOF'
module.exports = {};
EOF

# ========== __tests__/jobs.test.ts ==========
cat > __tests__/jobs.test.ts <<'EOF'
import {
  createJob,
  getJob,
  updateJob,
  incrementJobCompleted,
  __clearJobs,
  Job,
} from '@/lib/jobs';

describe('jobs module', () => {
  beforeEach(() => {
    __clearJobs();
  });

  describe('createJob', () => {
    it('creates a job with correct initial values', () => {
      const job = createJob('j1', 'plumbers', 10);
      expect(job.jobId).toBe('j1');
      expect(job.category).toBe('plumbers');
      expect(job.total).toBe(10);
      expect(job.completed).toBe(0);
      expect(job.status).toBe('running');
      expect(typeof job.startTime).toBe('string');
      expect(job.endTime).toBeUndefined();
      expect(Number.isNaN(Date.parse(job.startTime))).toBe(false);
    });

    it('stores the job so it is retrievable', () => {
      createJob('j2', 'dentists', 5);
      expect(getJob('j2')).toBeDefined();
      expect(getJob('j2')!.category).toBe('dentists');
    });

    it('overwrites an existing job with the same id', () => {
      createJob('j3', 'a', 1);
      createJob('j3', 'b', 2);
      expect(getJob('j3')!.category).toBe('b');
      expect(getJob('j3')!.total).toBe(2);
    });

    it('supports zero total', () => {
      const job = createJob('j4', 'x', 0);
      expect(job.total).toBe(0);
    });
  });

  describe('getJob', () => {
    it('returns undefined for unknown id', () => {
      expect(getJob('nope')).toBeUndefined();
    });
  });

  describe('updateJob', () => {
    it('applies partial updates and returns the updated job', () => {
      createJob('u1', 'cat', 3);
      const updated = updateJob('u1', { status: 'failed', completed: 2 });
      expect(updated!.status).toBe('failed');
      expect(updated!.completed).toBe(2);
      expect(getJob('u1')!.status).toBe('failed');
    });

    it('returns undefined and does not throw for unknown id', () => {
      expect(updateJob('ghost', { completed: 1 })).toBeUndefined();
    });

    it('can set endTime', () => {
      createJob('u2', 'cat', 1);
      const now = new Date().toISOString();
      updateJob('u2', { endTime: now });
      expect(getJob('u2')!.endTime).toBe(now);
    });
  });

  describe('incrementJobCompleted', () => {
    it('increments completed by 1 by default', () => {
      createJob('i1', 'cat', 5);
      const j = incrementJobCompleted('i1');
      expect(j!.completed).toBe(1);
      expect(j!.status).toBe('running');
    });

    it('increments by a custom amount', () => {
      createJob('i2', 'cat', 5);
      const j = incrementJobCompleted('i2', 3);
      expect(j!.completed).toBe(3);
    });

    it('marks completed and sets endTime when reaching total', () => {
      createJob('i3', 'cat', 2);
      incrementJobCompleted('i3');
      const done = incrementJobCompleted('i3');
      expect(done!.completed).toBe(2);
      expect(done!.status).toBe('completed');
      expect(done!.endTime).toBeDefined();
      expect(Number.isNaN(Date.parse(done!.endTime!))).toBe(false);
    });

    it('handles concurrent increments correctly (no lost updates)', () => {
      createJob('i4', 'cat', 100);
      for (let k = 0; k < 100; k++) incrementJobCompleted('i4');
      const job = getJob('i4')!;
      expect(job.completed).toBe(100);
      expect(job.status).toBe('completed');
    });

    it('returns undefined for unknown id', () => {
      expect(incrementJobCompleted('ghost')).toBeUndefined();
    });

    it('keeps status completed when exceeding total', () => {
      createJob('i5', 'cat', 1);
      incrementJobCompleted('i5');
      const over = incrementJobCompleted('i5');
      expect(over!.completed).toBe(2);
      expect(over!.status).toBe('completed');
    });
  });

  describe('__clearJobs', () => {
    it('removes all jobs', () => {
      createJob('c1', 'a', 1);
      createJob('c2', 'b', 1);
      __clearJobs();
      expect(getJob('c1')).toBeUndefined();
      expect(getJob('c2')).toBeUndefined();
    });
  });
});
EOF

# ========== __tests__/ollamaHelper.test.ts ==========
cat > __tests__/ollamaHelper.test.ts <<'EOF'
/**
 * @jest-environment node
 */
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Helper to (re)load the module fresh with current process.env
async function load() {
  let mod: typeof import('@/lib/ollamaHelper');
  jest.isolateModules(() => {
    mod = require('@/lib/ollamaHelper');
  });
  return mod!;
}

describe('extractWithOllama', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    // restore a clean env without USE_OLLAMA
    process.env = { ...originalEnv };
    delete process.env.USE_OLLAMA;
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns null immediately when USE_OLLAMA=false', async () => {
    process.env.USE_OLLAMA = 'false';
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('some text');
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('parses JSON from a well-formed response', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        response: '{"contact_person":"John","phone":"123","company_name":"Acme","address":"1 Main St"}',
      },
    });
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('Acme plumbing, John 123');
    expect(result).toEqual({
      contact_person: 'John',
      phone: '123',
      company_name: 'Acme',
      address: '1 Main St',
    });
  });

  it('extracts JSON embedded in surrounding text', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { response: 'Sure! Here is the data: {"company_name":"Beta","phone":null} done.' },
    });
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('Beta corp');
    expect(result).toEqual({ company_name: 'Beta', phone: null });
  });

  it('returns null when response contains no JSON object', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: 'no json here' } });
    const { extractWithOllama } = await load();
    expect(await extractWithOllama('text')).toBeNull();
  });

  it('returns null when JSON is malformed', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: '{invalid json,}' } });
    const { extractWithOllama } = await load();
    expect(await extractWithOllama('text')).toBeNull();
  });

  it('returns null and logs when axios request fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('connection refused'));
    const { extractWithOllama } = await load();
    const result = await extractWithOllama('text');
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it('posts to the default Ollama URL with default model', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: '{"a":1}' } });
    const { extractWithOllama } = await load();
    await extractWithOllama('hello');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        model: 'llama3',
        stream: false,
        format: 'json',
        prompt: expect.stringContaining('hello'),
      })
    );
  });

  it('respects OLLAMA_URL and OLLAMA_MODEL env overrides', async () => {
    process.env.OLLAMA_URL = 'http://example.com/gen';
    process.env.OLLAMA_MODEL = 'mistral';
    mockedAxios.post.mockResolvedValue({ data: { response: '{"x":2}' } });
    const { extractWithOllama } = await load();
    await extractWithOllama('test');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://example.com/gen',
      expect.objectContaining({ model: 'mistral' })
    );
  });

  it('includes the input text in the prompt', async () => {
    mockedAxios.post.mockResolvedValue({ data: { response: '{"a":1}' } });
    const { extractWithOllama } = await load();
    await extractWithOllama('UNIQUE_MARKER_TEXT');
    const call = mockedAxios.post.mock.calls[0][1] as any;
    expect(call.prompt).toContain('UNIQUE_MARKER_TEXT');
  });
});
EOF

# ========== __tests__/page.test.tsx ==========
cat > __tests__/page.test.tsx <<'EOF'
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Home from '@/app/page';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResponse(data: any, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

describe('Home page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/refined-results')) return jsonResponse([]);
      if (url.startsWith('/api/history-results')) return jsonResponse([]);
      return jsonResponse({});
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('renders heading and input', async () => {
    render(<Home />);
    expect(screen.getByText(/India Business Scraper/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/plumbers, dentists/i)).toBeInTheDocument();
  });

  it('fetches refined results on mount', async () => {
    render(<Home />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/refined-results'));
  });

  it('alerts when starting scrape without a category', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    render(<Home />);
    fireEvent.click(screen.getByText('Start Scraping'));
    expect(alertSpy).toHaveBeenCalledWith('Enter a category');
    alertSpy.mockRestore();
  });

  it('starts a scrape and shows progress', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/start-scrape') {
        return jsonResponse({ jobId: 'j1', total: 5, message: 'Scraping started' });
      }
      if (url === '/api/job/j1') {
        return jsonResponse({ jobId: 'j1', total: 5, completed: 2, status: 'running', startTime: '' });
      }
      return jsonResponse([]);
    });

    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'plumbers' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Start Scraping'));
    });

    await waitFor(() => expect(screen.getByText(/Progress: 0 \/ 5/)).toBeInTheDocument());
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it('polls job progress and stops on completion', async () => {
    let jobCalls = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/start-scrape') {
        return jsonResponse({ jobId: 'j9', total: 2, message: 'started' });
      }
      if (url === '/api/job/j9') {
        jobCalls++;
        // Complete on the first poll so we deterministically stop
        return jsonResponse({ jobId: 'j9', total: 2, completed: 2, status: 'completed', startTime: '' });
      }
      return jsonResponse([]);
    });

    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'x' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Start Scraping'));
    });

    // Advance one poll interval; async timer flush lets checkProgress run,
    // set status to 'completed', and clear the interval.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });

    expect(jobCalls).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
  });

  it('switches between refined and history views', async () => {
    render(<Home />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/refined-results'));

    fireEvent.click(screen.getByText('History (All)'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/history-results'));

    fireEvent.click(screen.getByText('Refined (Unique)'));
    await waitFor(() =>
      expect(mockFetch.mock.calls.some((c) => c[0] === '/api/refined-results')).toBe(true)
    );
  });

  it('includes category in fetch URL when set', async () => {
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'cafes' },
    });
    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('category=cafes')
        )
      ).toBe(true)
    );
  });

  it('renders "No data found" when results are empty', async () => {
    render(<Home />);
    await waitFor(() => expect(screen.getByText('No data found')).toBeInTheDocument());
  });

  it('renders result rows with business data', async () => {
    const item = {
      id: 1,
      category: 'plumbers',
      district_id: 1,
      district_name: 'Pune',
      business_name: 'Best Plumbing',
      contact_person: 'Raj',
      phone: '9876543210',
      address: '123 MG Road',
      website: 'https://example.com',
      last_updated: '2026-01-01T00:00:00Z',
    };
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/refined-results')) return jsonResponse([item]);
      return jsonResponse([]);
    });
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Best Plumbing')).toBeInTheDocument());
    expect(screen.getByText('Raj')).toBeInTheDocument();
    expect(screen.getByText('9876543210')).toBeInTheDocument();
    expect(screen.getByText('Pune')).toBeInTheDocument();
    expect(screen.getByText('Link')).toHaveAttribute('href', 'https://example.com');
  });

  it('shows dash for missing optional fields', async () => {
    const item = {
      id: 2,
      category: 'x',
      district_id: 1,
      district_name: 'Goa',
      business_name: 'Solo Shop',
      contact_person: null,
      phone: null,
      address: null,
      website: null,
      last_updated: null,
    };
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/refined-results')) return jsonResponse([item]);
      return jsonResponse([]);
    });
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Solo Shop')).toBeInTheDocument());
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  it('handles scrape start error gracefully', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/start-scrape') return jsonResponse({ error: 'No districts found' });
      return jsonResponse([]);
    });
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'x' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Start Scraping'));
    });
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('No districts found'))
    );
    alertSpy.mockRestore();
  });
});
EOF

# ========== __tests__/api.routes.test.ts ==========
cat > __tests__/api.routes.test.ts <<'EOF'
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock the db module before importing the routes
jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: {
    all: jest.fn(),
    get: jest.fn(),
    run: jest.fn(),
  },
}));

import db from '@/lib/db';
import { GET as districtsGET } from '@/app/api/districts/route';
import { GET as historyGET } from '@/app/api/history-results/route';
import { GET as refinedGET } from '@/app/api/refined-results/route';

const mockedDb = db as unknown as {
  all: jest.Mock;
  get: jest.Mock;
  run: jest.Mock;
};

function mockAll(rows: any[], err: Error | null = null) {
  mockedDb.all.mockImplementation((sql: string, paramsOrCb: any, cb?: any) => {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    callback(err, rows);
  });
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe('GET /api/districts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns list of districts', async () => {
    const rows = [
      { id: 1, name: 'Anantapur', state: 'Andhra Pradesh' },
      { id: 2, name: 'Pune', state: 'Maharashtra' },
    ];
    mockAll(rows);
    const res = await districtsGET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual(rows);
    expect(mockedDb.all).toHaveBeenCalledWith(
      expect.stringContaining('FROM districts'),
      expect.any(Function)
    );
  });

  it('orders by name', async () => {
    mockAll([]);
    await districtsGET();
    expect(mockedDb.all.mock.calls[0][0]).toContain('ORDER BY name');
  });

  it('returns empty array when no districts', async () => {
    mockAll([]);
    const res = await districtsGET();
    expect(await res.json()).toEqual([]);
  });

  it('propagates db errors (rejects)', async () => {
    mockAll([], new Error('db failure'));
    await expect(districtsGET()).rejects.toThrow('db failure');
  });
});

describe('GET /api/history-results', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all history rows without filters', async () => {
    const rows = [{ id: 1, business_name: 'Shop', district_name: 'Pune' }];
    mockAll(rows);
    const res = await historyGET(makeRequest('http://localhost/api/history-results'));
    const data = await res.json();
    expect(data).toEqual(rows);
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('FROM scraped_data');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });

  it('filters by category', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results?category=plumbers'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('h.category = ?');
    expect(params).toContain('plumbers');
  });

  it('filters by district_id and parses it as integer', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results?district_id=7'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('h.district_id = ?');
    expect(params).toContain(7);
  });

  it('combines category and district filters with AND', async () => {
    mockAll([]);
    await historyGET(
      makeRequest('http://localhost/api/history-results?category=a&district_id=3')
    );
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('h.category = ? AND h.district_id = ?');
    expect(params).toEqual(['a', 3]);
  });

  it('limits results to 1000 and orders by scraped_at DESC', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results'));
    const [sql] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('ORDER BY h.scraped_at DESC LIMIT 1000');
  });

  it('ignores empty-string category param', async () => {
    mockAll([]);
    await historyGET(makeRequest('http://localhost/api/history-results?category='));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });
});

describe('GET /api/refined-results', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns refined rows without filters', async () => {
    const rows = [{ id: 1, business_name: 'Cafe', district_name: 'Jaipur' }];
    mockAll(rows);
    const res = await refinedGET(makeRequest('http://localhost/api/refined-results'));
    expect(await res.json()).toEqual(rows);
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('FROM refined_data');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });

  it('filters by category', async () => {
    mockAll([]);
    await refinedGET(makeRequest('http://localhost/api/refined-results?category=dentists'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('r.category = ?');
    expect(params).toEqual(['dentists']);
  });

  it('filters by district_id', async () => {
    mockAll([]);
    await refinedGET(makeRequest('http://localhost/api/refined-results?district_id=11'));
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('r.district_id = ?');
    expect(params).toEqual([11]);
  });

  it('combines both filters', async () => {
    mockAll([]);
    await refinedGET(
      makeRequest('http://localhost/api/refined-results?category=x&district_id=2')
    );
    const [sql, params] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('r.category = ? AND r.district_id = ?');
    expect(params).toEqual(['x', 2]);
  });

  it('limits to 500 and orders by last_updated DESC', async () => {
    mockAll([]);
    await refinedGET(makeRequest('http://localhost/api/refined-results'));
    const [sql] = mockedDb.all.mock.calls[0];
    expect(sql).toContain('ORDER BY r.last_updated DESC LIMIT 500');
  });
});
EOF

# ========== __tests__/job.route.test.ts ==========
cat > __tests__/job.route.test.ts <<'EOF'
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/jobs', () => ({
  getJob: jest.fn(),
}));

import { getJob } from '@/lib/jobs';
import { GET } from '@/app/api/job/[jobId]/route';

const mockedGetJob = getJob as jest.Mock;

function makeRequest(): NextRequest {
  return new NextRequest(new Request('http://localhost/api/job/abc'));
}

function ctx(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

describe('GET /api/job/[jobId]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the job when found', async () => {
    const job = {
      jobId: 'abc',
      category: 'plumbers',
      total: 10,
      completed: 4,
      status: 'running',
      startTime: new Date().toISOString(),
    };
    mockedGetJob.mockReturnValue(job);
    const res = await GET(makeRequest(), ctx('abc'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(job);
    expect(mockedGetJob).toHaveBeenCalledWith('abc');
  });

  it('returns 404 when job not found', async () => {
    mockedGetJob.mockReturnValue(undefined);
    const res = await GET(makeRequest(), ctx('missing'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data).toEqual({ error: 'Job not found' });
  });

  it('awaits params promise (Next 16 async params)', async () => {
    mockedGetJob.mockReturnValue(undefined);
    // Should not throw even though params is a Promise
    await expect(GET(makeRequest(), ctx('xyz'))).resolves.toBeDefined();
    expect(mockedGetJob).toHaveBeenCalledWith('xyz');
  });
});
EOF

# ========== __tests__/start-scrape.route.test.ts ==========
cat > __tests__/start-scrape.route.test.ts <<'EOF'
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: { all: jest.fn() },
}));
jest.mock('@/lib/scraper', () => ({ scrapeDistrict: jest.fn() }));
jest.mock('@/lib/districtSeeder', () => ({ seedDistricts: jest.fn() }));
jest.mock('@/lib/jobs', () => ({
  createJob: jest.fn((id: string, cat: string, total: number) => ({
    jobId: id, category: cat, total, completed: 0, status: 'running', startTime: new Date().toISOString(),
  })),
  incrementJobCompleted: jest.fn(),
}));

import db from '@/lib/db';
import { scrapeDistrict } from '@/lib/scraper';
import { seedDistricts } from '@/lib/districtSeeder';
import { createJob, incrementJobCompleted } from '@/lib/jobs';
import { POST } from '@/app/api/start-scrape/route';

const mockedDb = db as unknown as { all: jest.Mock };
const mockedScrape = scrapeDistrict as jest.Mock;
const mockedSeed = seedDistricts as jest.Mock;
const mockedCreateJob = createJob as jest.Mock;
const mockedIncrement = incrementJobCompleted as jest.Mock;

function post(body: any): NextRequest {
  return new NextRequest(
    new Request('http://localhost/api/start-scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function mockDistricts(rows: any[], onSecondCall?: any[]) {
  let call = 0;
  mockedDb.all.mockImplementation((sql: string, cb: any) => {
    call++;
    if (call === 1) cb(null, rows);
    else cb(null, onSecondCall ?? rows);
  });
}

// Flush the fire-and-forget background async work
async function flushBackground(times = 20) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('POST /api/start-scrape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CONCURRENCY;
    mockedScrape.mockResolvedValue(3);
  });
  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
    (console.error as jest.Mock).mockRestore();
  });

  it('returns 400 when category is missing', async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Category is required' });
  });

  it('returns 400 when category is empty string', async () => {
    const res = await POST(post({ category: '' }));
    expect(res.status).toBe(400);
  });

  it('starts scraping with existing districts and returns jobId + total', async () => {
    mockDistricts([
      { id: 1, name: 'Pune' },
      { id: 2, name: 'Jaipur' },
    ]);
    const res = await POST(post({ category: 'plumbers' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.message).toBe('Scraping started');
    expect(typeof data.jobId).toBe('string');
    expect(mockedCreateJob).toHaveBeenCalledWith(data.jobId, 'plumbers', 2);
    expect(mockedSeed).not.toHaveBeenCalled();
  });

  it('invokes scrapeDistrict for every district in background', async () => {
    mockDistricts([
      { id: 1, name: 'Pune' },
      { id: 2, name: 'Jaipur' },
      { id: 3, name: 'Surat' },
    ]);
    await POST(post({ category: 'dentists' }));
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledTimes(3);
    expect(mockedScrape).toHaveBeenCalledWith('dentists', 'Pune', 1);
    expect(mockedScrape).toHaveBeenCalledWith('dentists', 'Jaipur', 2);
    expect(mockedScrape).toHaveBeenCalledWith('dentists', 'Surat', 3);
    expect(mockedIncrement).toHaveBeenCalledTimes(3);
  });

  it('seeds districts when table is empty, then scrapes', async () => {
    mockDistricts([], [{ id: 9, name: 'NewDistrict' }]);
    const res = await POST(post({ category: 'cafes' }));
    expect(mockedSeed).toHaveBeenCalled();
    const data = await res.json();
    expect(data.total).toBe(1);
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledWith('cafes', 'NewDistrict', 9);
  });

  it('returns 500 when no districts exist even after seeding', async () => {
    mockDistricts([], []);
    const res = await POST(post({ category: 'cafes' }));
    expect(mockedSeed).toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'No districts found' });
    expect(mockedScrape).not.toHaveBeenCalled();
  });

  it('continues scraping other districts when one fails', async () => {
    mockDistricts([
      { id: 1, name: 'Good' },
      { id: 2, name: 'Bad' },
      { id: 3, name: 'AlsoGood' },
    ]);
    mockedScrape.mockImplementation((cat: string, name: string) =>
      name === 'Bad' ? Promise.reject(new Error('boom')) : Promise.resolve(5)
    );
    await POST(post({ category: 'x' }));
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledTimes(3);
    // increment still called for the failed one (in finally)
    expect(mockedIncrement).toHaveBeenCalledTimes(3);
  });

  it('caps worker count to number of districts', async () => {
    process.env.CONCURRENCY = '10';
    mockDistricts([{ id: 1, name: 'Only' }]);
    await POST(post({ category: 'x' }));
    await flushBackground();
    expect(mockedScrape).toHaveBeenCalledTimes(1);
  });
});
EOF

echo "✅ All files created successfully!"
echo "Now run 'npm install' and then 'npm run dev' to start the application."
