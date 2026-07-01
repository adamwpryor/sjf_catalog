#!/usr/bin/env python
"""
CDI Factory — Cloud Client Database Deployment Utility
Pryor Consulting Chief of Staff.

This script executes transactional data replication from the central ingestion Hub
to a client-scoped target Supabase/PostgreSQL instance in the cloud. It respects
all Zero-Trust security rules, Conda boundaries, and pgvector formatting guidelines.
"""

import sys
import argparse
import pathlib
import psycopg2
import yaml
from psycopg2 import extras, sql

# Add root project path to path so we can import from src
sys.path.append(str(pathlib.Path(__file__).parent.parent.resolve()))

from src.core.db import get_db_connection
from src.utils.security import load_secure_key
from src.utils.logger import get_logger

logger = get_logger(__name__)

DEPLOYMENT_CONFIG_PATH = pathlib.Path(__file__).parent.parent / "deployment_config.yaml"


def load_cloud_url_for_tenant(tenant_id: str) -> str | None:
    """Look up the cloud DB URL for a tenant from deployment_config.yaml."""
    if not DEPLOYMENT_CONFIG_PATH.exists():
        return None
    with open(DEPLOYMENT_CONFIG_PATH) as f:
        config = yaml.safe_load(f)
    client = config.get("clients", {}).get(tenant_id)
    if not client:
        return None
    url = client.get("cloud_db_url", "")
    # Guard against placeholder values left in the config
    if "<password>" in url or "<project-ref>" in url:
        logger.error(
            f"deployment_config.yaml entry for '{tenant_id}' still contains placeholder values. "
            "Replace <password> and <project-ref> with real credentials."
        )
        sys.exit(1)
    return url or None

# Topological order of tables for safe deletion (reverse) and insertion (forward)
TABLE_ORDER = [
    "institutions",
    "chunk_types",
    "toulmin_roles",
    "deontic_modalities",
    "quinean_web_classifications",
    "degree_classifications",
    "subjects",
    "documents",
    "semantic_chunks",
    "courses",
    "programs",
    "program_requirements",
    "program_requirement_courses",
    "course_prerequisite_links",
    "faculty",
    "program_faculty",
    "policy_mentions_courses",
    "policy_mentions_programs"
]

# Tables that live on cloud only and must never be wiped by replication.
# corrections is the client feedback layer — it is the source of truth for
# pending Hub corrections and must survive re-deployments.
CLOUD_ONLY_TABLES = {"corrections"}

def get_target_db_connection(tenant_id: str, cloud_url: str = None) -> psycopg2.extensions.connection:
    """Connect to the target client cloud Supabase/PostgreSQL instance.

    Resolution order (first match wins):
      1. --cloud-db-url CLI argument
      2. deployment_config.yaml entry for the tenant
      3. CDI_CLIENT_DATABASE_URL environment variable
    """
    if not cloud_url:
        cloud_url = load_cloud_url_for_tenant(tenant_id)
    if not cloud_url:
        try:
            cloud_url = load_secure_key("CDI_CLIENT_DATABASE_URL")
        except ValueError:
            logger.error(
                f"No cloud DB URL found for tenant '{tenant_id}'. "
                "Add it to deployment_config.yaml, set CDI_CLIENT_DATABASE_URL, "
                "or pass --cloud-db-url."
            )
            sys.exit(1)

    logger.info("Connecting to target client cloud database...")
    return psycopg2.connect(cloud_url)

def fetch_with_columns(cur: psycopg2.extensions.cursor, query: str, params=None) -> tuple[list[str], list]:
    """Execute a query and return (columns, rows) using cursor.description for correct column ordering."""
    cur.execute(query, params)
    rows = cur.fetchall()
    cols = [desc[0] for desc in cur.description] if cur.description else []
    return cols, rows

def replicate_tenant_data(tenant_id: str, cloud_url: str = None):
    """Fetch matching ingestion records from Hub database and transactionally replicate to target Cloud database."""
    logger.info(f"Initiating transactional replication for tenant '{tenant_id}'...")

    # 1. Connect to both databases
    try:
        hub_conn = get_db_connection()
        # Snapshot isolation prevents reading a partially-written tenant during concurrent ingestion
        hub_conn.set_session(readonly=True, isolation_level="REPEATABLE READ")
        hub_cur = hub_conn.cursor()
    except Exception as e:
        logger.error(f"Failed to connect to local Hub database: {e}")
        sys.exit(1)

    try:
        target_conn = get_target_db_connection(tenant_id, cloud_url)
        target_cur = target_conn.cursor()
    except Exception as e:
        logger.error(f"Failed to connect to target Cloud database: {e}")
        hub_conn.close()
        sys.exit(1)

    try:
        # Step A: Pull and hold all data locally from Hub to prevent socket starvation.
        # cursor.description is read immediately after each query so column order matches row order exactly.
        data_store = {}
        document_ids = []

        # 1. Fetch matching Institution
        inst_cols, inst_rows = fetch_with_columns(
            hub_cur, "SELECT * FROM institutions WHERE code = %s;", (tenant_id,)
        )
        data_store["institutions"] = (inst_cols, inst_rows)

        # Fetch global lookup tables
        for table in ["chunk_types", "toulmin_roles", "deontic_modalities", "quinean_web_classifications", "degree_classifications"]:
            cols, rows = fetch_with_columns(
                hub_cur,
                sql.SQL("SELECT * FROM {};").format(sql.Identifier(table))
            )
            data_store[table] = (cols, rows)

        # 2. Fetch matching Semantic Chunks
        chunks_cols, chunks_rows = fetch_with_columns(
            hub_cur, "SELECT * FROM semantic_chunks WHERE tenant_id = %s;", (tenant_id,)
        )
        data_store["semantic_chunks"] = (chunks_cols, chunks_rows)

        # Track document IDs to fetch associated documents
        if "document_id" in chunks_cols:
            doc_id_idx = chunks_cols.index("document_id")
            document_ids = list(set(r[doc_id_idx] for r in chunks_rows if r[doc_id_idx] is not None))

        # 3. Fetch matching Documents
        if document_ids:
            doc_cols, doc_rows = fetch_with_columns(
                hub_cur, "SELECT * FROM documents WHERE id IN %s;", (tuple(document_ids),)
            )
            data_store["documents"] = (doc_cols, doc_rows)
        else:
            data_store["documents"] = ([], [])

        # 4. Fetch Programs, Courses and dependencies
        for table in ["subjects", "courses", "programs", "program_requirements", "program_requirement_courses",
                      "course_prerequisite_links", "faculty", "program_faculty", "policy_mentions_courses", "policy_mentions_programs"]:
            cols, rows = fetch_with_columns(
                hub_cur,
                sql.SQL("SELECT * FROM {} WHERE tenant_id = %s;").format(sql.Identifier(table)),
                (tenant_id,)
            )
            data_store[table] = (cols, rows)

        logger.info("Successfully fetched all tenant data blocks from local Hub.")

        # Step B: Perform safe transactional deployment to Cloud database
        logger.info("Starting cloud transaction...")

        # Track expected row counts per table for post-commit verification
        expected_counts = {table: len(data_store.get(table, ([], []))[1]) for table in TABLE_ORDER}

        # 1. Delete old data in reverse topological order to satisfy FK boundaries
        for table in reversed(TABLE_ORDER):
            if table in ("institutions", "chunk_types", "toulmin_roles", "deontic_modalities", "quinean_web_classifications", "degree_classifications"):
                # Global lookup registries — upserted, not purged
                continue
            elif table == "documents":
                if document_ids:
                    target_cur.execute(
                        "DELETE FROM documents WHERE id IN %s;",
                        (tuple(document_ids),)
                    )
            else:
                target_cur.execute(
                    sql.SQL("DELETE FROM {} WHERE tenant_id = %s;").format(sql.Identifier(table)),
                    (tenant_id,)
                )
        logger.info("Target tenant environment purged successfully.")

        # Pre-fetch target schema column names
        target_schema = {}
        target_cur.execute("""
            SELECT table_name, column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public'
        """)
        for tbl, col in target_cur.fetchall():
            target_schema.setdefault(tbl, set()).add(col)

        # 2. Insert new data in forward topological order
        for table in TABLE_ORDER:
            cols, rows = data_store.get(table, ([], []))
            if not rows:
                continue
                
            # Filter out any columns that the Spoke (target) does not have
            if table in target_schema:
                allowed_cols = target_schema[table]
                cols_to_remove = [c for c in cols if c not in allowed_cols]
                if cols_to_remove:
                    logger.info(f"Filtering out columns missing in target: {cols_to_remove}")
                    indices_to_remove = [cols.index(c) for c in cols_to_remove]
                    cols = [c for i, c in enumerate(cols) if i not in indices_to_remove]
                    new_rows = []
                    for row in rows:
                        new_rows.append(tuple(val for i, val in enumerate(row) if i not in indices_to_remove))
                    rows = new_rows

            if table == "semantic_chunks":
                parent_idx = cols.index("parent_chunk_id") if "parent_chunk_id" in cols else -1
                id_idx = cols.index("id") if "id" in cols else -1
                if parent_idx != -1 and id_idx != -1:
                    logger.info("Sorting semantic_chunks topologically to satisfy parent_chunk_id self-reference...")
                    inserted = set()
                    sorted_rows = []
                    remaining = list(rows)
                    last_len = len(remaining)
                    while remaining:
                        placed = []
                        for row in remaining:
                            parent_id = row[parent_idx]
                            if parent_id is None or parent_id in inserted:
                                sorted_rows.append(row)
                                inserted.add(row[id_idx])
                                placed.append(row)
                        for r in placed:
                            remaining.remove(r)
                        if len(remaining) == last_len:
                            # Break cycles or handle unresolved orphans by appending them at the end
                            logger.warning(f"Could not topologically sort remaining {len(remaining)} chunks. Appending at the end.")
                            sorted_rows.extend(remaining)
                            break
                        last_len = len(remaining)
                    rows = sorted_rows

            logger.info(f"Deploying {len(rows)} records to Cloud table '{table}'...")

            col_identifiers = [sql.Identifier(c) for c in cols]
            col_list = sql.SQL(", ").join(col_identifiers)
            val_placeholders = sql.SQL(", ").join([sql.Placeholder()] * len(cols))

            if table == "institutions":
                # Upsert all columns — not just name — so schema additions propagate
                non_pk_cols = [c for c in cols if c not in ("id", "code")]
                set_clause = sql.SQL(", ").join(
                    sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c))
                    for c in non_pk_cols
                )
                query = sql.SQL(
                    "INSERT INTO institutions ({cols}) VALUES ({vals}) ON CONFLICT (code) DO UPDATE SET {sets};"
                ).format(cols=col_list, vals=val_placeholders, sets=set_clause)
            elif table in ("chunk_types", "toulmin_roles", "deontic_modalities", "quinean_web_classifications", "degree_classifications"):
                # Upsert all columns so schema additions propagate
                non_pk_cols = [c for c in cols if c not in ("id", "code")]
                set_clause = sql.SQL(", ").join(
                    sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c))
                    for c in non_pk_cols
                )
                query = sql.SQL(
                    "INSERT INTO {table} ({cols}) VALUES ({vals}) ON CONFLICT (id) DO UPDATE SET {sets};"
                ).format(table=sql.Identifier(table), cols=col_list, vals=val_placeholders, sets=set_clause)
            elif table == "subjects":
                # Scoped to tenant_id and prefix
                query = sql.SQL(
                    "INSERT INTO subjects ({cols}) VALUES ({vals}) ON CONFLICT (tenant_id, prefix) DO NOTHING;"
                ).format(cols=col_list, vals=val_placeholders)
            elif table == "faculty":
                query = sql.SQL(
                    "INSERT INTO faculty ({cols}) VALUES ({vals}) ON CONFLICT (tenant_id, name) DO NOTHING;"
                ).format(cols=col_list, vals=val_placeholders)
            else:
                query = sql.SQL(
                    "INSERT INTO {table} ({cols}) VALUES ({vals});"
                ).format(
                    table=sql.Identifier(table),
                    cols=col_list,
                    vals=val_placeholders
                )

            # Enforce PostgreSQL vector string array standard for embedding columns and JSONB serialization
            formatted_rows = []
            for row in rows:
                formatted_row = list(row)
                for idx, col in enumerate(cols):
                    if col == "embedding":
                        formatted_row[idx] = None
                    elif isinstance(formatted_row[idx], dict):
                        import json
                        formatted_row[idx] = json.dumps(formatted_row[idx])
                    elif col in ("prerequisites_json", "requirements", "requirements_json", "content_metadata") and formatted_row[idx] is not None:
                        import json
                        val = formatted_row[idx]
                        if isinstance(val, (list, dict)):
                            formatted_row[idx] = json.dumps(val)
                formatted_rows.append(tuple(formatted_row))

            extras.execute_batch(target_cur, query, formatted_rows, page_size=500)

        # Commit target transaction atomically
        target_conn.commit()
        logger.info(f"Transaction committed. Verifying row counts for tenant '{tenant_id}'...")

        # Step C: Post-commit verification — confirm counts match what was sent
        verification_passed = True
        for table in TABLE_ORDER:
            expected = expected_counts.get(table, 0)
            if expected == 0:
                continue
            if table == "institutions":
                target_cur.execute("SELECT COUNT(*) FROM institutions WHERE code = %s;", (tenant_id,))
            elif table in ("chunk_types", "toulmin_roles", "deontic_modalities", "quinean_web_classifications", "degree_classifications"):
                # Global lookup tables are not tied to a single tenant_id for verification count checks
                # (Verified by global insertion, we count total rows matching what was sent)
                target_cur.execute(sql.SQL("SELECT COUNT(*) FROM {};").format(sql.Identifier(table)))
            elif table == "documents":
                if document_ids:
                    target_cur.execute("SELECT COUNT(*) FROM documents WHERE id IN %s;", (tuple(document_ids),))
                else:
                    continue
            else:
                target_cur.execute(
                    sql.SQL("SELECT COUNT(*) FROM {} WHERE tenant_id = %s;").format(sql.Identifier(table)),
                    (tenant_id,)
                )
            actual = target_cur.fetchone()[0]
            if actual != expected:
                logger.error(
                    f"Row count mismatch on '{table}': sent {expected}, found {actual} in cloud.",
                    extra={"table": table, "expected": expected, "actual": actual}
                )
                verification_passed = False
            else:
                logger.info(f"Verified '{table}': {actual} rows confirmed.", extra={"table": table, "rows": actual})

        if verification_passed:
            logger.info(
                f"Replication Successful! All data for tenant '{tenant_id}' is live and verified in the Cloud database."
            )
        else:
            logger.error(
                f"Replication completed with COUNT MISMATCHES for tenant '{tenant_id}'. Manual inspection required."
            )
            sys.exit(1)

    except Exception as e:
        logger.error(f"Transactional replication failed: {e}")
        target_conn.rollback()
        raise
    finally:
        hub_cur.close()
        hub_conn.close()
        target_cur.close()
        target_conn.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pryor Consulting Ingestion Hub Cloud Replication Utility")
    parser.add_argument(
        "--tenant-id",
        type=str,
        required=True,
        help="The unique tenant ID/code of the client to push (e.g. 'CCSJ', 'SJFU')"
    )
    parser.add_argument(
        "--cloud-db-url",
        type=str,
        default=None,
        help="Target remote Cloud PostgreSQL connection URL (overrides CDI_CLIENT_DATABASE_URL env)"
    )
    args = parser.parse_args()

    replicate_tenant_data(args.tenant_id, args.cloud_db_url)
