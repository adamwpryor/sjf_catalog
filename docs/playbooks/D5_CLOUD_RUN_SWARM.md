# Playbook D5 — Cloud Run swarm service

Builds and deploys the Python service that runs the catalog's AI agents.

`TRANSFER_RUNBOOK.md` §3.4 is where this sits. This document owns the commands, the verification,
and the rollback.

**Why this is a workstream and not a footnote.** Five of the seven AI features route through this
service — committee-minutes extraction, delta resolution, chunk re-sync, in-PDF corrections, and the
manual entry assistant. The web application deploys and runs perfectly well without it; those five
features simply return errors. And the most likely misconfiguration produces `401` on every call,
which reads like a broken deployment rather than a missing secret.

---

## 1. What is being deployed

`services/swarm/Dockerfile` builds a Conda environment from `environment.yml` and serves
`services.swarm.main:app` with uvicorn on `$PORT`. The image carries the native stack WeasyPrint
needs for PDF rendering, which is why it is a container rather than a serverless function.

The service exposes seven routes. `/health` and the docs endpoints are deliberately open; the five
agent routes require a bearer token.

**Model calls are keyless.** The agents are written against an Anthropic-shaped API, but
`_anthropic_client()` returns the Vertex shim in `services/swarm/overrides/vertex.py`, which calls
Vertex Gemini using Application Default Credentials. There is no Anthropic key path in this
deployment, and `EXTRACT_MINUTES_MODEL` — which still names a Claude model — is inert. On Cloud Run
the credentials come from the runtime service account, so nothing needs to be provisioned beyond
granting that account access.

---

## 2. Before you start

- Your GCP project has `run`, `artifactregistry`, and `aiplatform` enabled.
- The service account from D3 exists (`roles/aiplatform.user` is the one that matters here).

```bash
export PROJECT_ID='<your-gcp-project>'
export REGION='us-east5'
export REPO='catalog'
export SERVICE='sjf-catalog-swarm'
export SA_EMAIL="sjf-catalog-app@${PROJECT_ID}.iam.gserviceaccount.com"
```

`us-east5` matches `GOOGLE_CLOUD_LOCATION`, the region the Python services default to. It does not
have to match the region the web application uses for embeddings — those are separate variables and
both regions serve the models each side needs.

---

## 3. Procedure

### 3.1 Artifact Registry

```bash
gcloud artifacts repositories create "$REPO" \
  --project="$PROJECT_ID" --location="$REGION" \
  --repository-format=docker \
  --description="Catalog platform containers"
```

### 3.2 Build

From the repository root — the Dockerfile expects the project root as build context, not
`services/swarm/`:

```bash
gcloud builds submit \
  --project="$PROJECT_ID" \
  --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/swarm-api:$(date +%Y%m%d-%H%M)" \
  --file services/swarm/Dockerfile \
  .
```

The Conda environment build is slow — several minutes is normal. If it fails on a native
dependency, that is the packaging issue noted in the handover gaps: the environment has only ever
been built on Windows, and `weasyprint` pulls a native stack.

### 3.3 Generate a token

```bash
export SWARM_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
```

Store it wherever your team keeps secrets. It goes in two places and must match exactly: this
service, and the web application's `SWARM_API_TOKEN`.

### 3.4 Deploy

```bash
gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" \
  --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/swarm-api:<tag-from-3.2>" \
  --service-account="$SA_EMAIL" \
  --set-env-vars="SWARM_API_TOKEN=${SWARM_TOKEN},GOOGLE_CLOUD_LOCATION=${REGION},VERTEX_GEMINI_MODEL=gemini-2.5-pro,INSTITUTION_LEGAL_NAME=St. John Fisher University" \
  --no-allow-unauthenticated \
  --memory=2Gi --timeout=300
```

Notes on the flags that are not obvious:

- `--service-account` is what makes the keyless Vertex path work. Omit it and the service runs as
  the default compute account, which usually lacks `roles/aiplatform.user`, and every agent call
  fails with a 403 that looks nothing like a permissions problem.
- `--memory=2Gi` because WeasyPrint's rendering path is memory-hungry; the 512Mi default will
  restart the container mid-render.
- `--timeout=300` because minutes extraction is a long-context call.
- `--no-allow-unauthenticated` puts Cloud Run's own IAM in front of the bearer token. Two layers,
  and you want both.

### 3.5 Point the application at it

Record the service URL from the deploy output and set it on the Vercel project:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SWARM_API_URL` | the Cloud Run HTTPS URL |
| `SWARM_API_TOKEN` | the same value as §3.3 |

---

## 4. Verification

### 4.1 The service is up

```bash
curl -s "$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')/health"
```

Expect `{"status":"ok","service":"sjf-catalog-swarm-api"}`. `/health` answers without a token by
design, so this proves the container started — nothing more.

### 4.2 The token gate is closed

```bash
URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/agent/manual-entry-assistant" -d '{}'
```

Expect **401**. Anything else means the token is not being enforced, and the agent routes are open
to anyone who finds the URL.

> [!IMPORTANT]
> **If `SWARM_API_TOKEN` is unset, the service refuses every authenticated route with 401 — by
> design.** It fails closed rather than open. So a blanket 401 across all five features means the
> secret is missing, not that the deployment is broken. That distinction is the single most likely
> hour to be lost during this migration.

### 4.3 An agent route responds when authenticated

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/agent/manual-entry-assistant" \
  -H "Authorization: Bearer $SWARM_TOKEN" -H 'Content-Type: application/json' -d '{}'
```

Expect **422**, not 200 — the request passed the gate and failed validation on an empty body, which
is exactly what you want to see. A 401 here means the tokens on the two sides do not match.

### 4.4 End to end through the application

In the deployed app, open **New Catalog Builder** and use the manual entry assistant. A
conversational reply proves the whole path: browser → Next.js proxy → session check → bearer token →
Cloud Run → Vertex.

That route is proxied server-side deliberately. An earlier revision called it directly from the
browser, which left an unauthenticated, billable model endpoint exposed.

---

## 5. Rollback

Cloud Run keeps revisions, so rollback is a traffic switch rather than a redeploy:

```bash
gcloud run revisions list --service="$SERVICE" --project="$PROJECT_ID" --region="$REGION"

gcloud run services update-traffic "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" \
  --to-revisions=<previous-revision>=100
```

To remove the service entirely:

```bash
gcloud run services delete "$SERVICE" --project="$PROJECT_ID" --region="$REGION"
```

The web application degrades rather than breaks: the dashboard, catalog browsing, the assistant, and
the diff log all keep working, and the five agent features return errors until a service is
available again.
