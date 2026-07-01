import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { runRemediation } from '@/app/api/catalog/remediate/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Scheduled data-quality remediation (Vercel Cron).
 *
 * Runs the remediation engine in apply mode against the most recent published catalog: auto-fixes the
 * mechanical lane and files judgment proposals into the corrections queue. Runs as the privileged DB
 * role (no session user). Guarded by CRON_SECRET. Idempotent.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Target the most recent published (non-draft) catalog.
  const rows = await query(
    `SELECT id, version FROM documents WHERE version NOT ILIKE '%draft%' ORDER BY created_at DESC LIMIT 1`
  );
  if (!rows.length) return NextResponse.json({ status: 'noop', reason: 'no published catalog' });

  const result = await runRemediation({ catalogId: rows[0].id, mode: 'apply' });
  const body = await result.json();
  return NextResponse.json({ status: 'ok', catalog: rows[0].version, ...body });
}
