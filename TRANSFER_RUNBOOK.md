# Account & Billing Separation Transfer Runbook

This runbook defines the complete, step-by-step operational procedure for transferring the St. John Fisher University (SJFU) Catalog System from the initial developer/vendor infrastructure to SJFU (or a designated successor vendor).

> [!IMPORTANT]
> **STRICT ORDERING PROPERTY: Zero-Downtime Parallel Verification**
> The original owner's infrastructure, authentication keys, and service deployments **must remain live and untouched** while the client's replacement infrastructure is provisioned, deployed, and verified.
> **No credentials, projects, service accounts, or database keys may be revoked until Section 3.7.**

---

## 1. Overview & Infrastructure Hand-Off Seams

The system architecture consists of three core infrastructure layers:
1. **Frontend & App Edge (Vercel):** Next.js single-page dashboard and API routes, with Vercel Cron scheduling for nightly remediation.
2. **Data & Auth (Supabase PostgreSQL):** Single-tenant Postgres database, pgvector embeddings, and Supabase Auth with RLS role mapping (`user_roles`).
3. **Cloud Intelligence & Storage (Google Cloud Platform):** Keyless Vertex AI generation (`gemini-2.5-pro` in `us-east5`) and query embeddings (`gemini-embedding-001` in `us-central1`), Cloud Run Python Swarm service, and GCS storage bucket (`gs://sjfu-assets`).

---

## 2. Infrastructure Inventory & Re-Pointing Target Matrix

When transferring ownership, the values in the table below must be replaced with the client's newly provisioned resource identifiers:

| Identifier / Resource | Former / Developer Value | Client Re-Pointing Target |
| --- | --- | --- |
| **GCP Project ID** | Developer Cloud Project ID | `SJF_GCP_PROJECT_ID` |
| **GCP Project Number** | Developer Project Number | `SJF_GCP_PROJECT_NUMBER` |
| **GCP Region (Generation)** | `us-east5` (Python Swarm) | `us-east5` (Cloud Run) |
| **GCP Region (Embeddings)** | `us-central1` (TypeScript) | `us-central1` (Vertex AI) |
| **GCS Asset Bucket** | `gs://sjfu-assets` | `gs://sjf-catalog-assets` (or client bucket) |
| **Supabase Project Ref** | Legacy developer ref | Client Supabase Project Ref |
| **Vercel Team ID** | Developer Vercel Team | Client Vercel Team |
| **GitHub Repository** | `adamwpryor/sjf_catalog` | Client / Institutional GitHub Repo |

---

## 3. Environment Variable Inventory

Every environment variable read by the codebase is inventoried below. Every variable must be configured in the client's Vercel deployment and local developer environments ([.env.example](.env.example)).

| Environment Variable | Scope | Target Service | Purpose & Re-pointing Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `[public]` | Next.js Client & Server | Supabase API URL for client's Supabase project. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `[public]` | Next.js Client | Supabase Anon JWT key for public auth client. |
| `SUPABASE_SERVICE_ROLE_KEY` | `[secret]` | Next.js Server | Supabase Service-Role Key for administrative writes. |
| `DATABASE_URL` | `[secret]` | Next.js / Harness / scripts | Pooled Postgres connection string for the client's Supabase project. Read by `src/lib/db.ts`, `verification_harness/db.py`, and the backfill scripts. |
| `GCP_PROJECT_ID` | `[config]` | Next.js & Python | Client GCP Project ID. **Must throw on startup if missing.** |
| `GCP_PROJECT_NUMBER` | `[config]` | Next.js (WIF) | Client GCP Project Number for Workload Identity. |
| `GCP_LOCATION` | `[config]` | Next.js (Vertex) | Vertex AI region for embeddings (`us-central1`). |
| `GCP_WORKLOAD_IDENTITY_POOL_ID` | `[config]` | Next.js (WIF) | Client WIF Pool ID in GCP. |
| `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | `[config]` | Next.js (WIF) | Client WIF Provider ID (`vercel-team`). Must match the Vercel OIDC issuer mode. |
| `GCP_SERVICE_ACCOUNT_EMAIL` | `[config]` | Next.js (WIF) | Client Service Account email for STS token exchange. |
| `VERCEL_OIDC_TOKEN` | `[secret]` | Next.js Server | OIDC token generated dynamically by Vercel platform. |
| `SWARM_API_TOKEN` | `[secret]` | Next.js & Swarm | Shared bearer token for Swarm microservice auth. |
| `NEXT_PUBLIC_SWARM_API_URL` | `[public]` | Next.js Client & Server | Public HTTPS URL of the deployed Cloud Run Swarm service. |
| `CORRECTION_DAILY_LIMIT` | `[config]` | Next.js Server | Daily in-PDF correction call limit per user (default: `150`). |
| `CRON_SECRET` | `[secret]` | Next.js Server | Bearer secret for Vercel Cron `/api/cron/remediate` route. |
| `GCP_BUCKET_NAME` | `[config]` | Next.js Server | GCS bucket name for catalog asset storage. |
| `INSTITUTION_LEGAL_NAME` | `[config]` | Next.js & Swarm | `"St. John Fisher University"` |
| `GOOGLE_CLOUD_LOCATION` | `[config]` | Python Swarm & Harness | Vertex region for the Python services (`us-east5`). Separate variable from `GCP_LOCATION`; neither reads the other. |
| `GOOGLE_APPLICATION_CREDENTIALS` | `[secret]` | Local dev | Path to a service-account JSON for local runs. Unset in deployed environments, which use WIF. |
| `GCP_PRIVATE_KEY` | `[secret]` | Next.js | Service-account key used only when the WIF exchange is unavailable. |
| `VERTEX_AI_ACCESS_TOKEN` | `[secret]` | Next.js | Pre-minted Vertex token; overrides the WIF/ADC exchange when set. |
| `GCS_BUCKET` | `[config]` | Next.js & Harness | Alias of `GCP_BUCKET_NAME` — both are read; keep them identical. |
| `HUB_WEBHOOK_SECRET` | `[secret]` | Next.js Server | Bearer secret for the hub→spoke ingest webhook. Required only if hub pushes are used. |
| `SCRATCH_DIR` | `[config]` | Backfill scripts | Output directory for one-shot repair scripts (default `./artifacts/scratch`). |
| `VERTEX_GEMINI_MODEL` | `[config]` | Python Swarm | Default generation model (`gemini-2.5-pro`). |
| `VERTEX_TIER2_MODEL` | `[config]` | Python Swarm | Fast/cheap model (`gemini-2.5-flash`). |
| `EXTRACT_MINUTES_MODEL` | `[config]` | Python Swarm | Model alias override for minutes extraction. |
| `GEMINI_API_KEY` | `[secret]` | Next.js | Optional. Google AI Studio API key fallback. |
| `ANTHROPIC_API_KEY` | `[secret]` | Next.js | Optional. Anthropic API key if enabling Claude models in UI. |
| `OPENAI_API_KEY` | `[secret]` | Next.js | Optional. OpenAI API key if enabling GPT models in UI. |
| `OPENAI_API_BASE_URL` | `[config]` | Next.js | Optional. Base URL for OpenAI-compatible proxies. |

---

## 4. Step-by-Step Executable Transfer Checklist

### Step 3.1 — Client Account Provisioning
Create accounts under the client's own organization and billing:
- [ ] **GCP:** Create a new Google Cloud Project (`sjf-catalog-production`). Enable APIs: `aiplatform.googleapis.com`, `run.googleapis.com`, `iamcredentials.googleapis.com`, `sts.googleapis.com`, `storage.googleapis.com`, `artifactregistry.googleapis.com`.
- [ ] **Supabase:** Create a new Supabase organization and project. Record the database connection string and API keys.
- [ ] **Vercel:** Create or designate a Vercel Team for SJFU.
- [ ] **GitHub:** Create or select the institutional target repository (e.g. `sjf-edu/sjf_catalog`).

### Step 3.2 — Storage & Data Migration
- [ ] **GCS Bucket Copy:** Create the GCS asset bucket in the new GCP project. Copy all catalog assets from `gs://sjfu-assets` using `gcloud storage cp -r gs://sjfu-assets/* gs://<client-bucket-name>/`.
- [ ] **Database Migrations:** Apply all 25 schema migration files in [supabase/migrations/](supabase/migrations/) sequentially to the new Supabase database instance.
- [ ] **Auth Redirect Allowlist:** In Supabase Dashboard $\rightarrow$ Authentication $\rightarrow$ URL Configuration, add the client's Vercel production domain and local development URLs (`http://localhost:3000/*`).
- [ ] **User Roles Seed:** Insert initial administrative roles into `user_roles` (as specified in [supabase/migrations/20260605183000_rls_policies.sql](supabase/migrations/20260605183000_rls_policies.sql)):
  ```sql
  INSERT INTO user_roles (user_id, role) VALUES ('<client-admin-uuid>', 'owner');
  ```

### Step 3.3 — Identity Plumbing & Workload Identity Federation (WIF)
- [ ] **GCP Service Account:** Create a service account `sjf-catalog-app@<client-gcp-project>.iam.gserviceaccount.com`. Grant IAM roles:
  * `Vertex AI User` (`roles/aiplatform.user`)
  * `Storage Object Admin` (`roles/storage.objectAdmin`)
- [ ] **WIF Pool & Provider:** Create a Workload Identity Federation Pool (`vercel-pool`) and Provider (`vercel-team`). Configure the provider to trust Vercel's OIDC issuer (`https://oidc.vercel.com`) and attribute condition matching the client's Vercel Team ID (`assertion.sub.startsWith('owner:<client-vercel-team-id>')`).
- [ ] **IAM Policy Binding:** Allow the WIF pool principal to impersonate the service account:
  ```bash
  gcloud iam service-accounts add-iam-policy-binding sjf-catalog-app@<client-gcp-project>.iam.gserviceaccount.com \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/<client-project-number>/locations/global/workloadIdentityPools/vercel-pool/*"
  ```

### Step 3.4 — Deploy Python Swarm Service to Cloud Run
- [ ] **Build Image:** Build [services/swarm/Dockerfile](services/swarm/Dockerfile) into the client's GCP Artifact Registry:
  ```bash
  gcloud builds submit --tag us-east5-docker.pkg.dev/<client-gcp-project>/catalog/swarm-api:latest services/swarm/
  ```
- [ ] **Deploy Cloud Run:** Deploy the container to Cloud Run in `us-east5`:
  ```bash
  gcloud run deploy sjf-catalog-swarm \
    --image us-east5-docker.pkg.dev/<client-gcp-project>/catalog/swarm-api:latest \
    --region us-east5 \
    --set-env-vars "SWARM_API_TOKEN=<secure-token>,VERTEX_GEMINI_MODEL=gemini-2.5-pro,GCP_PROJECT_ID=<client-gcp-project>" \
    --no-allow-unauthenticated
  ```
- [ ] Record the assigned HTTPS Cloud Run service URL (`NEXT_PUBLIC_SWARM_API_URL`).

### Step 3.5 — Deploy Next.js Frontend to Vercel
- [ ] **Unlink Local Vercel Config:** Remove any local `.vercel/project.json` file.
- [ ] **Link & Deploy:** Run `vercel link` to connect the working tree to the client's Vercel Team.
- [ ] **Configure Environment Variables:** Add all variables from Section 3 into Vercel Project Settings.
- [ ] **Cron Schedule:** Verify that [vercel.json](vercel.json) configures the Cron schedule for automated remediation:
  ```json
  {
    "crons": [{ "path": "/api/cron/remediate", "schedule": "0 2 * * *" }]
  }
  ```

### Step 3.6 — Side-by-Side Verification Gate (Adam's System Still Live)
Perform full system verification on the client's deployment while the original developer stack remains active:
- [ ] **Web App Availability:** Open client's Vercel deployment URL; confirm the dashboard loads cleanly.
- [ ] **Authentication:** Log in via Supabase Auth using a newly provisioned user account.
- [ ] **WIF $\rightarrow$ Vertex AI Pipeline:** In `AI Catalog Assistant` tab (`assistant`), submit a query. Confirm response generates without errors (validates Vercel OIDC $\rightarrow$ GCP STS $\rightarrow$ Vertex AI token exchange).
- [ ] **Harness Verification:** Run the verification harness against the client's database:
  ```bash
  # DATABASE_URL must already point at the CLIENT's Supabase project for this to test anything
  python -m verification_harness --version 2025-2026-undergraduate --tier2 estimate
  ```
- [ ] **Python Swarm Import & Route Smoke Test:**
  ```bash
  python -c "import services.swarm.main as m; assert type(m._anthropic_client()).__name__ == 'VertexShimClient'; print('swarm ok')"
  ```
- [ ] **Automated CI Suite:** Confirm `.github/workflows/ci.yml` passes cleanly on push.

### Step 3.7 — DNS Cutover & Credential Revocation
Once Step 3.6 passes 100%:
- [ ] **DNS Cutover:** Point institutional domain (e.g. `catalog-tool.sjf.edu`) to the new Vercel deployment.
- [ ] **Rotate Supabase Service-Role Key:** Rotate the service-role JWT and database password in the new Supabase project.
- [ ] **Revoke Developer GCP Credentials:** Revoke former developer service account keys and delete the old WIF provider.
- [ ] **Remove Access:** Remove developer user accounts from the client's GCP, Vercel, and Supabase projects.
- [ ] **Repository Transfer:** Transfer or archive the original GitHub repository ([adamwpryor/sjf_catalog](https://github.com/adamwpryor/sjf_catalog)).
- [ ] **Decommission Old Services:** Decommission the original Vercel project and old developer Supabase project (`zkoimkcctqigisfeqlpv`).

### Step 3.8 — Zero-Bill Confirmation
- [ ] **Billing Audit:** One full billing cycle after cutover, review the original developer's GCP, Supabase, Vercel, and model-provider billing portals.
- [ ] **Confirm Zero Balance:** Verify that **\$0.00** in recurring charges are billed to the developer's personal or consulting accounts for this system.
