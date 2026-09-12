import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';
import { isLocalRequest, localOnlyResponse } from '@/lib/local-only';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  return NextResponse.json(job);
}
