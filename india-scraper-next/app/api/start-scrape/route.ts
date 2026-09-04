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
          console.log(\`✅ \${district.name}: \${count} results\`);
        } catch (error) {
          console.error(\`❌ Failed \${district.name}:\`, error.message);
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
