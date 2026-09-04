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
