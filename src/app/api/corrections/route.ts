import { NextResponse } from 'next/server';
import { query, queryWithAuth } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { TENANT_ID } from '@/lib/brand';

/**
 * Fetches all curriculum corrections from the database.
 * Supports optional filtering by status.
 *
 * @param req - The incoming GET request containing query parameters.
 * @returns A JSON array of correction records.
 */
export async function GET(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {
      // Surface an explicit 401 rather than letting queryWithAuth throw (→ 500) on a
      // missing RLS context. RLS still restricts the queue to reviewer roles.
      return NextResponse.json({ error: "Unauthorized access." }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status');
    const tenantId = TENANT_ID;

    // 1. Fetch DB Records
    const queryText = `SELECT id, tenant_id, target_table, target_row_id, field_name,
                            current_value, proposed_value, reason, status,
                            submitted_by, submitted_at, reviewed_at, applied_at,
                            applied_to_document_id, applied_patch
                     FROM corrections
                     WHERE tenant_id = $1 ORDER BY submitted_at DESC;`;
    let dbRecords: any[] = [];
    try {
      dbRecords = await queryWithAuth(queryText, [tenantId], userId);
    } catch (dbErr) {
      console.error("Corrections DB fetch failed:", dbErr);
      throw dbErr;
    }

    // 2. Return DB Records
    let combined = [...dbRecords];

    if (statusFilter) {
      combined = combined.filter(r => r.status === statusFilter);
    }

    return NextResponse.json(combined);
  } catch (e: any) {
    console.error("Fetch Corrections Error: ", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Submits a new structured delta correction override.
 * Stores the proposed change in the corrections table.
 *
 * @param req - The incoming POST request containing correction payload.
 * @returns A JSON response with success status and the newly created correction record.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized access." }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const { target_table, target_row_id, field_name, current_value, proposed_value, reason } = body;

    // Validate payload constraints
    if (!target_table || !target_row_id || !field_name || proposed_value === undefined) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }

    const tenantId = TENANT_ID;
    const email = session.user.email;

    // target_row_id is a uuid column, but manual entry / the AI assistant supply a human
    // identifier (e.g. "GEOL-110"). Only store it in the uuid column when it's actually a uuid;
    // otherwise leave it NULL (a registrar/the apply step resolves the real row) and keep the
    // identifier visible in the reason so nothing is lost.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const targetIsUuid = typeof target_row_id === 'string' && UUID_RE.test(target_row_id.trim());
    const targetUuid = targetIsUuid ? target_row_id.trim() : null;
    const reasonWithTarget = targetIsUuid
      ? reason
      : [reason, `Target: ${target_table} ${target_row_id}`].filter(Boolean).join(' | ');

    const res = await queryWithAuth(
      `INSERT INTO corrections
        (tenant_id, target_table, target_row_id, field_name, current_value, proposed_value, reason, status, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       RETURNING id, submitted_at;`,
      [tenantId, target_table, targetUuid, field_name, current_value, proposed_value, reasonWithTarget, email],
      userId
    );

    return NextResponse.json({
      status: "success",
      message: "Correction logged successfully.",
      correction: res[0]
    }, { status: 201 });

  } catch (e: any) {
    console.error("Submit Correction Error: ", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Updates the review state of an existing correction record (e.g. pending to applied).
 * Restricted to users with admin privileges.
 *
 * @param req - The incoming PATCH request containing correction ID and new status.
 * @returns A JSON response containing the updated status details.
 */
export async function PATCH(req: Request) {
  try {
    // Role-based auth validation: Admin ONLY
    // Role-based auth validation
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user) {
      return NextResponse.json({ error: "Forbidden: Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;

    const roleQuery = await query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
    const userRole = roleQuery.length > 0 ? roleQuery[0].role : null;

    if (!userRole || !['admin', 'registrar', 'owner'].includes(userRole)) {
      return NextResponse.json({ error: "Forbidden: Elevated access required." }, { status: 403 });
    }

    const body = await req.json();
    const { id, status, reviewer_notes } = body;

    if (!id || !status) {
      return NextResponse.json({ error: "Missing ID or status payload." }, { status: 400 });
    }

    const allowedStatus = ['pending', 'approved', 'applied', 'rejected'];
    if (!allowedStatus.includes(status)) {
      return NextResponse.json({ error: "Invalid status value." }, { status: 400 });
    }

    const tenantId = TENANT_ID;
    const now = new Date();

    // Set timestamps conditionally based on status
    let queryText = '';
    const params: any[] = [status, id, tenantId];

    if (status === 'applied') {
      queryText = `UPDATE corrections 
                   SET status = $1, applied_at = $4, reviewed_at = $4 
                   WHERE id = $2 AND tenant_id = $3 
                   RETURNING id, status, applied_at;`;
      params.push(now);
    } else {
      queryText = `UPDATE corrections 
                   SET status = $1, reviewed_at = $4 
                   WHERE id = $2 AND tenant_id = $3 
                   RETURNING id, status, reviewed_at;`;
      params.push(now);
    }

    const res = await queryWithAuth(queryText, params, userId);
    
    if (res.length === 0) {
      return NextResponse.json({ error: "Correction record not found." }, { status: 404 });
    }

    return NextResponse.json({
      status: "success",
      message: `Correction status updated to ${status}.`,
      correction: res[0]
    });

  } catch (e: any) {
    console.error("Review Correction Error: ", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
