import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { KnowledgeStore } from '@/lib/knowledge/store';
import { chunkBusinessRecord } from '@/lib/knowledge/chunker';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';

export async function POST(request: NextRequest) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  try {
    const body = await request.json().catch(() => ({}));
    const { category } = body;

    const where = category ? 'WHERE category = ?' : '';
    const params = category ? [category] : [];

    const rows = await new Promise<any[]>((resolve, reject) => {
      db.all(
        `SELECT * FROM refined_data ${where} ORDER BY last_updated DESC`,
        params,
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const store = new KnowledgeStore();
    let ingested = 0;

    for (const record of rows) {
      const sourceKey = `business:${record.category}:${record.district_id}:${record.id}`;
      const chunks = chunkBusinessRecord(record);
      if (chunks.length === 0) continue;

      await store.ingestChunks(sourceKey, chunks, {
        source_type: 'business',
        source_key: sourceKey,
        title: record.business_name,
        metadata: {
          category: record.category,
          district_id: record.district_id,
          business_name: record.business_name,
        },
      });
      ingested++;
    }

    return NextResponse.json({
      success: true,
      ingested,
      total_records: rows.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Knowledge refresh error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
