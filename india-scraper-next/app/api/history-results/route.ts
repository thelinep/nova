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
