#!/bin/bash
# India District Business Scraper - Setup & Run Script
# This script creates the full Next.js application with all necessary files,
# installs dependencies, configures environment, and starts the dev server.

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== India District Business Scraper Setup ===${NC}"

# ---------- Prerequisites ----------
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed. Please install Node.js (v18+) and npm.${NC}"
    exit 1
fi
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Node.js version 18 or higher is required (found $NODE_VERSION).${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v) found.${NC}"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}npm is not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm -v) found.${NC}"

# Check Ollama (optional) - warn if not found and USE_OLLAMA is true
if ! command -v ollama &> /dev/null; then
    echo -e "${YELLOW}⚠️ Ollama not found. If you want to use Ollama for enrichment, install it from https://ollama.com.${NC}"
    echo -e "${YELLOW}   You can disable Ollama by setting USE_OLLAMA=false in .env.local later.${NC}"
    OLLAMA_AVAILABLE=false
else
    echo -e "${GREEN}✓ Ollama found.${NC}"
    OLLAMA_AVAILABLE=true
fi

# ---------- Project Directory ----------
PROJECT_DIR="india-scraper-next"
if [ -d "$PROJECT_DIR" ]; then
    echo -e "${YELLOW}Directory '$PROJECT_DIR' already exists. Do you want to overwrite it? (y/N)${NC}"
    read -r OVERWRITE
    if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
        echo "Exiting."
        exit 0
    fi
    rm -rf "$PROJECT_DIR"
fi

mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

echo -e "${GREEN}✓ Created project directory: $PROJECT_DIR${NC}"

# ---------- Initialize package.json ----------
echo -e "${YELLOW}Initializing package.json...${NC}"
npm init -y > /dev/null 2>&1

# ---------- Install Dependencies ----------
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install sqlite3 puppeteer-extra puppeteer-extra-plugin-stealth axios next react react-dom typescript @types/node --save > /dev/null 2>&1
npm install --save-dev @types/puppeteer @types/sqlite3 > /dev/null 2>&1

echo -e "${GREEN}✓ Dependencies installed.${NC}"

# ---------- Create Directory Structure ----------
mkdir -p app/api/start-scrape
mkdir -p app/api/job/[jobId]
mkdir -p app/api/refined-results
mkdir -p app/api/history-results
mkdir -p app/api/districts
mkdir -p lib
mkdir -p types
mkdir -p public

# ---------- Create Environment File ----------
cat > .env.local <<EOF
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=llama3
CONCURRENCY=5
RETRY_ATTEMPTS=3
RETRY_DELAY=2000
USE_OLLAMA=${OLLAMA_AVAILABLE:-true}
EOF
echo -e "${GREEN}✓ Created .env.local${NC}"

# ---------- Create TypeScript Config ----------
cat > tsconfig.json <<EOF
{
  "compilerOptions": {
    "target": "es5",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "node",
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

# ---------- Create Next.js Config ----------
cat > next.config.js <<EOF
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['sqlite3', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  },
};

module.exports = nextConfig;
EOF

# ---------- Create Database Module ----------
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
});

export default db;
EOF

# ---------- Create Ollama Helper ----------
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

# ---------- Create District Seeder ----------
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
  districts.forEach(d => stmt.run(d.name, d.state));
  stmt.finalize();
  console.log(`Inserted ${districts.length} districts.`);
}
EOF

# ---------- Create Scraper Module ----------
cat > lib/scraper.ts <<'EOF'
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
        [category, districtId, item.business_name, item.contact_person, item.phone, item.address, item.website],
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
      let previousHeight = 0;
      let scrollAttempts = 0;
      const maxScrolls = 10;

      while (scrollAttempts < maxScrolls) {
        const items = await page.$$('div[role="article"]');
        for (const item of items) {
          try {
            const name = await item.$eval('div.fontHeadlineSmall', el => el.innerText).catch(() => '');
            const address = await item.$eval('div[data-item-id="address"]', el => el.innerText).catch(() => '');
            const phone = await item.$eval('div[data-item-id="phone"]', el => el.innerText).catch(() => '');
            const website = await item.$eval('div[data-item-id="website"]', el => el.innerText).catch(() => '');

            const combinedText = `${name} ${address} ${phone} ${website}`;
            const enriched = await extractWithOllama(combinedText);

            results.push({
              business_name: name || enriched?.company_name || '',
              contact_person: enriched?.contact_person || null,
              phone: phone || enriched?.phone || null,
              address: address || enriched?.address || null,
              website: website || null,
            });
          } catch (e) { /* skip */ }
        }

        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await sleep(2000 + Math.random() * 1000);
        const newHeight = await page.evaluate('document.body.scrollHeight');
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
      console.error(`Scraping ${districtName} failed (attempt ${attempt}):`, error.message);
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

# ---------- Create In-Memory Job Store ----------
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

export function updateJob(jobId: string, updates: Partial<Job>): void {
  if (jobs[jobId]) {
    jobs[jobId] = { ...jobs[jobId], ...updates };
  }
}
EOF

# ---------- API Routes ----------
# start-scrape
cat > app/api/start-scrape/route.ts <<'EOF'
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { scrapeDistrict } from '@/lib/scraper';
import { createJob, updateJob } from '@/lib/jobs';
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
  const job = createJob(jobId, category, districts.length);

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
          updateJob(jobId, { completed: job.completed + 1 });
          console.log(`✅ ${district.name}: ${count} results`);
        } catch (error) {
          console.error(`❌ Failed ${district.name}:`, error.message);
          updateJob(jobId, { completed: job.completed + 1 });
        }
        // update status if completed
        if (job.completed === job.total) {
          updateJob(jobId, { status: 'completed', endTime: new Date().toISOString() });
        }
      }
    }

    const workers = Array(Math.min(concurrency, districts.length)).fill(null).map(() => worker());
    await Promise.all(workers);
    if (job.completed === job.total) {
      updateJob(jobId, { status: 'completed', endTime: new Date().toISOString() });
    }
  })();

  return NextResponse.json({ jobId, total: districts.length, message: 'Scraping started' });
}
EOF

# job/[jobId]
cat > app/api/job/[jobId]/route.ts <<'EOF'
import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';

export async function GET(
  request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const job = getJob(params.jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  return NextResponse.json(job);
}
EOF

# refined-results
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

# history-results
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

# districts
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

# ---------- Frontend Page ----------
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
    if (!jobId) return;
    try {
      const res = await fetch(`/api/job/${jobId}`);
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

# ---------- Layout ----------
cat > app/layout.tsx <<'EOF'
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

# ---------- Tailwind CSS Setup ----------
# We'll add Tailwind CSS configuration for styling
npm install -D tailwindcss postcss autoprefixer > /dev/null 2>&1
npx tailwindcss init -p > /dev/null 2>&1

# Update tailwind.config.js
cat > tailwind.config.js <<'EOF'
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
EOF

# Add Tailwind directives to global CSS
mkdir -p app
cat > app/globals.css <<'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;
EOF

# Import globals in layout
sed -i "s/<body>/<body><\/body>/" app/layout.tsx
# Instead of sed, we'll overwrite layout.tsx with proper import
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

# ---------- Finalize ----------
echo -e "${GREEN}✓ All files created.${NC}"

# ---------- Start the Application ----------
echo -e "${YELLOW}Starting Next.js development server...${NC}"
echo -e "${GREEN}Access your app at http://localhost:3000${NC}"
echo -e "${GREEN}Press Ctrl+C to stop the server.${NC}"

# Run the dev server
npm run dev