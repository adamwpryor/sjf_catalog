# Playbook D3 — Workload Identity Federation

Creates the keyless trust path that lets your Vercel deployment call Vertex AI and Cloud Storage
without a service-account key file.

`TRANSFER_RUNBOOK.md` §3.3 is where this sits. This document owns the commands, the verification,
and the rollback.

**This is the one thing in the handover that cannot be copied.** A federation provider is bound to
a specific OIDC issuer — in this case your Vercel team's. The outgoing provider trusts a different
team and is useless to you no matter what permissions are granted on it. It must be created new.

**And it is the one that fails only in production.** Local development uses Application Default
Credentials and never exercises this path, so every check passes on a laptop and the first sign of
a misconfiguration is model calls failing on the deployed site.

---

## 1. How the exchange works

Worth reading once, because the failure modes are otherwise indistinguishable.

1. Vercel mints a short-lived OIDC token for the running deployment.
2. `src/lib/llm.ts` and `src/lib/gcs.ts` present it to Google STS, naming your pool and provider.
3. STS returns a federated token, which is then used to impersonate a service account.
4. That service account's IAM roles are what actually authorise the Vertex and Storage calls.

Four things must line up: the issuer, the audience, the attribute condition, and the impersonation
binding. A mistake in any one produces a 403, and the messages are not specific about which.

---

## 2. Before you start

- Your GCP project exists with `iamcredentials`, `sts`, `aiplatform`, and `storage` enabled.
- Your Vercel team exists, and you know its **team slug or ID** — the issuer depends on it.
- The GCS bucket from D2 exists.

```bash
export PROJECT_ID='<your-gcp-project>'
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export POOL_ID='vercel-pool'
export PROVIDER_ID='vercel-team'
export SA_NAME='sjf-catalog-app'
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
```

---

## 3. Procedure

### 3.1 Service account and roles

```bash
gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" \
  --display-name="SJF Catalog application"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/aiplatform.user"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/storage.objectViewer"
```

`roles/aiplatform.user` is required and is easy to miss — without it the federation succeeds and
every model call returns 403, which reads like a federation problem and is not. Grant
`roles/storage.objectAdmin` instead of `objectViewer` only if the deployment needs to write assets;
read access is enough for serving the catalog.

### 3.2 Workload identity pool and provider

```bash
gcloud iam workload-identity-pools create "$POOL_ID" \
  --project="$PROJECT_ID" --location=global \
  --display-name="Vercel deployments"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global \
  --workload-identity-pool="$POOL_ID" \
  --issuer-uri="https://oidc.vercel.com/<your-vercel-team-slug>" \
  --allowed-audiences="https://vercel.com/<your-vercel-team-slug>" \
  --attribute-mapping="google.subject=assertion.sub,attribute.aud=assertion.aud" \
  --attribute-condition="assertion.sub.startsWith('owner:<your-vercel-team-slug>:')"
```

> [!IMPORTANT]
> **The issuer must match your Vercel project's OIDC mode.** Vercel can issue tokens under a team
> issuer or a global one, and the URL differs. `.env.example` names the provider `vercel-team`
> precisely because this deployment expects the *team* issuer. If your project is set to global
> issuer mode, either change the project setting or build the provider against the global issuer —
> but do not mix them, because the mismatch surfaces only as a failed exchange in production.

### 3.3 Allow the pool to impersonate the service account

```bash
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/*"
```

### 3.4 Environment variables in Vercel

Set these on the Vercel project — all four, or the exchange is not attempted at all:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | your project id |
| `GCP_PROJECT_NUMBER` | your project **number**, not the id |
| `GCP_WORKLOAD_IDENTITY_POOL_ID` | `vercel-pool` |
| `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | `vercel-team` |
| `GCP_SERVICE_ACCOUNT_EMAIL` | the `$SA_EMAIL` above |

`GCP_PROJECT_ID` has no fallback by design: if it is missing the application throws at startup
rather than guessing a project. That is deliberate — an earlier revision defaulted to a hardcoded
project belonging to someone else.

---

## 4. Verification

### 4.1 The provider trusts what you think it trusts

```bash
gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global \
  --workload-identity-pool="$POOL_ID" \
  --format="yaml(oidc.issuerUri, oidc.allowedAudiences, attributeCondition, state)"
```

`state` must be `ACTIVE`, and the issuer must carry your team slug. This is a configuration read,
not a proof — it cannot tell you the exchange works.

### 4.2 The proof: a real request through the deployed app

There is no meaningful local test, because local runs use ADC and skip federation entirely. Deploy,
then open the **AI Catalog Assistant** tab and ask any catalog question.

- A grounded answer means the whole chain worked: Vercel OIDC → STS → impersonation → Vertex.
- A 403 means the chain broke. Work backwards: §4.1 for the issuer, then the impersonation binding
  in §3.3, then `roles/aiplatform.user` in §3.1.

### 4.3 Storage separately from Vertex

They use the same credentials but different roles, so one can work while the other does not. Load a
catalog page view in the app, or exercise a route that reads from the bucket. A page that renders
metadata but cannot show source markdown indicates the storage role, not the federation.

---

## 5. Rollback

Federation is additive — nothing existing is modified — so rollback is deletion, in reverse order:

```bash
gcloud iam workload-identity-pools providers delete "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID"

gcloud iam workload-identity-pools delete "$POOL_ID" \
  --project="$PROJECT_ID" --location=global

gcloud iam service-accounts delete "$SA_EMAIL" --project="$PROJECT_ID"
```

Pools and providers are soft-deleted and the names stay reserved for 30 days. If you need to
recreate one immediately with the same id, undelete it rather than waiting:

```bash
gcloud iam workload-identity-pools undelete "$POOL_ID" --project="$PROJECT_ID" --location=global
```

Do not delete the **outgoing** provider as part of this playbook. That belongs to cutover
(`TRANSFER_RUNBOOK.md` §3.7), after your deployment is serving.
