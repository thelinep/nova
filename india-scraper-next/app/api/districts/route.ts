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
