import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';

export async function GET(request: NextRequest) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  const rows = await new Promise<any[]>((resolve, reject) => {
    db.all('SELECT id, name, state FROM districts ORDER BY name', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
  return NextResponse.json(rows);
}
