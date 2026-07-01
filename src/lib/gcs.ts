import { Storage } from '@google-cloud/storage';
import { GCS_BUCKET } from '@/lib/brand';

/**
 * Securely exchanges Vercel's dynamic OIDC token for a Google STS federated token.
 * Dynamically constructs the provider path to authorize GCP resources.
 *
 * @param oidcToken - The incoming OIDC token string from Vercel.
 * @returns The newly minted GCP Service Account access token.
 */
export async function getFederatedAccessToken(oidcToken: string): Promise<string> {
  const projectNumber = process.env.GCP_PROJECT_NUMBER;
  const poolId = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID;
  const providerId = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;
  const saEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

  if (!oidcToken) {
    throw new Error("OIDC Token is missing or empty.");
  }
  if (!projectNumber) {
    throw new Error("GCP_PROJECT_NUMBER environment variable is missing.");
  }
  if (!poolId) {
    throw new Error("GCP_WORKLOAD_IDENTITY_POOL_ID environment variable is missing.");
  }
  if (!providerId) {
    throw new Error("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID environment variable is missing.");
  }
  if (!saEmail) {
    throw new Error("GCP_SERVICE_ACCOUNT_EMAIL environment variable is missing.");
  }

  // Construct the exact, absolute provider path required by Google Security Token Service (STS)
  const providerPath = `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  // A. Call Google Security Token Service (STS) to exchange Vercel OIDC JWT for a Google federated token
  // Note: Parameter names MUST be snake_case to conform to the RFC 8693 OAuth 2.0 Token Exchange standard.
  const stsUrl = "https://sts.googleapis.com/v1/token";
  const stsBody = {
    audience: `//iam.googleapis.com/${providerPath}`,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: oidcToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    scope: "https://www.googleapis.com/auth/cloud-platform",
  };

  console.log(`[GCS OIDC Exchange] Initiating Google STS Exchange for provider: ${providerPath}`);
  const stsRes = await fetch(stsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stsBody),
  });

  if (!stsRes.ok) {
    const errText = await stsRes.text();
    throw new Error(`Google STS token exchange failed: ${errText}`);
  }

  const stsData = await stsRes.json();
  const stsToken = stsData.access_token;

  // B. Call Google IAM Credentials API to generate an access token for our Service Account
  const impersonateUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:generateAccessToken`;
  const impersonateBody = {
    scope: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/devstorage.read_write"
    ],
    lifetime: "3600s",
  };

  console.log(`[GCS OIDC Exchange] Impersonating Service Account: ${saEmail}...`);
  const impRes = await fetch(impersonateUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${stsToken}`,
    },
    body: JSON.stringify(impersonateBody),
  });

  if (!impRes.ok) {
    const errText = await impRes.text();
    throw new Error(`Google IAM impersonation failed for ${saEmail}: ${errText}`);
  }

  const impData = await impRes.json();
  console.log(`[GCS OIDC Exchange] Successfully authenticated as ${saEmail}!`);
  return impData.accessToken;
}

/**
 * Dynamically resolves and authenticates a Google Cloud Storage client based on the environment context.
 */
export async function getStorageClient(req?: Request): Promise<Storage> {
  const hasGoogleCredentials = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const hasPrivateKey = !!process.env.GCP_PRIVATE_KEY;
  const oidcToken = req ? req.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN : process.env.VERCEL_OIDC_TOKEN;
  const hasOidc = !!oidcToken;
  const hasGcpVars = !!process.env.GCP_PROJECT_NUMBER && !!process.env.GCP_WORKLOAD_IDENTITY_POOL_ID && !!process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;

  if (hasGoogleCredentials) {
    // Option 1: Native Vercel GCP OIDC Integration
    console.log("[GCS SDK] Authenticating via native Vercel-generated GOOGLE_APPLICATION_CREDENTIALS file...");
    return new Storage();
  } else if (hasPrivateKey) {
    // Option 2: Standard Service Account JSON Private Key
    console.log("[GCS SDK] Authenticating via Service Account Private Key...");
    return new Storage({
      projectId: process.env.GCP_PROJECT_ID,
      credentials: {
        client_email: process.env.GCP_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GCP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      }
    });
  } else if (hasOidc && hasGcpVars) {
    // Option 3: Manual Workload Identity Federation (WIF) REST Token Exchange
    console.log("[GCS SDK] OIDC Token and GCP variables found. Initiating keyless REST OIDC exchange...");
    const accessToken = await getFederatedAccessToken(oidcToken!);
    
    const { OAuth2Client } = await import('google-auth-library');
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: accessToken });

    return new Storage({
      projectId: process.env.GCP_PROJECT_ID,
      authClient: authClient as any,
    });
  } else {
    // Option 4: Local development fallback (uses gcloud ADC)
    console.log("[GCS SDK] No active cloud credentials found. Falling back to local credentials...");
    return new Storage({
      projectId: process.env.GCP_PROJECT_ID,
    });
  }
}

/**
 * Retrieves the base bucket name, defaulting to the institution's configured
 * asset bucket (`GCS_BUCKET`), overridable per-call or via `GCP_BUCKET_NAME`.
 */
export function resolveBucketName(overrideName?: string): string {
  return overrideName || process.env.GCP_BUCKET_NAME || GCS_BUCKET;
}
