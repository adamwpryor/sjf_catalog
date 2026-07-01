/**
 * Server-side helper for authenticating calls to the FastAPI swarm (BUILD_PLAN §P8).
 *
 * The swarm enforces a bearer token (SWARM_API_TOKEN) on its /api/agent/* endpoints. This
 * module is server-only — never import it into a Client Component, or the secret would be
 * bundled into the browser. `SWARM_API_TOKEN` has no NEXT_PUBLIC_ prefix precisely so it
 * cannot leak client-side.
 */

/** Base URL of the swarm API (public — safe in the browser bundle). */
export const SWARM_BASE_URL =
  process.env.NEXT_PUBLIC_SWARM_API_URL || 'http://localhost:8080';

/**
 * Authorization headers for a server→swarm call. Returns an empty object when
 * SWARM_API_TOKEN is unset (local dev, where the swarm skips auth), so callers can
 * always spread the result unconditionally.
 */
export function swarmAuthHeaders(): Record<string, string> {
  const token = process.env.SWARM_API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
