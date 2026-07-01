import { Pool, PoolClient } from 'pg';
import dns from 'dns';

// Force DNS resolution to prefer IPv4 over IPv6 (resolves ETIMEDOUT on port 5432 on certain local networks)
dns.setDefaultResultOrder('ipv4first');

const connectionString = process.env.DATABASE_URL;

// Custom parser to handle passwords with raw '@' and URL-encoded '%40' safely
/**
 * Parses a custom connection string.
 *
 * @param {string} uri - The connection string to parse.
 * @returns {Object} The parsed configuration.
 */
function parseConnectionString(uri: string) {
  try {
    // 1. Remove postgresql:// or postgres:// prefix
    const cleanUri = uri.replace(/^(postgresql|postgres):\/\//, '');

    // 2. Find the last '@' sign, which separates credentials from the host
    const lastAtIndex = cleanUri.lastIndexOf('@');
    if (lastAtIndex === -1) {
      throw new Error("Invalid connection string format: missing '@'");
    }

    const credentialsPart = cleanUri.substring(0, lastAtIndex);
    const hostDbPart = cleanUri.substring(lastAtIndex + 1);

    // 3. Parse credentials (user:password)
    const colonIndex = credentialsPart.indexOf(':');
    if (colonIndex === -1) {
      throw new Error("Invalid connection string format: missing password separator ':'");
    }

    const user = decodeURIComponent(credentialsPart.substring(0, colonIndex));
    const password = decodeURIComponent(credentialsPart.substring(colonIndex + 1));

    // 4. Parse host, port, and database (host:port/database)
    const slashIndex = hostDbPart.indexOf('/');
    if (slashIndex === -1) {
      throw new Error("Invalid connection string format: missing database name separator '/'");
    }

    const hostPortPart = hostDbPart.substring(0, slashIndex);
    let database = hostDbPart.substring(slashIndex + 1);

    // Strip any trailing query parameters from the database name
    const questionMarkIndex = database.indexOf('?');
    if (questionMarkIndex !== -1) {
      database = database.substring(0, questionMarkIndex);
    }

    const portColonIndex = hostPortPart.indexOf(':');
    let host = hostPortPart;
    let port = 5432; // default postgres port

    if (portColonIndex !== -1) {
      host = hostPortPart.substring(0, portColonIndex);
      port = parseInt(hostPortPart.substring(portColonIndex + 1), 10);
    }

    return {
      user,
      password,
      host,
      port,
      database,
    };
  } catch (err: any) {
    console.error("src/lib/db.ts: Failed to parse DATABASE_URL with custom parser:", err.message);
    // Fall back to standard connectionString configuration
    return { connectionString: uri };
  }
}

// Singleton Pool instance
let pool: Pool | null = null;

/**
 * Gets the singleton database pool instance.
 *
 * @returns {Pool} The PostgreSQL pool.
 */
export function getDbPool(): Pool {
  if (!pool) {
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set in environment variables.");
    }
    const config = parseConnectionString(connectionString as string);
    console.log(`src/lib/db.ts: Initializing pg Pool with host: ${config.host || 'unknown'} and database: ${config.database || 'unknown'}`);
    pool = new Pool({
      ...config,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

/**
 * Executes a query on the database.
 *
 * @template T
 * @param {string} text - The query string.
 * @param {any[]} [params] - The query parameters.
 * @returns {Promise<T[]>} The query result rows.
 */
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const dbPool = getDbPool();
  const res = await dbPool.query(text, params);
  return res.rows;
}

/**
 * Gets a client from the database pool.
 *
 * @returns {Promise<PoolClient>} The database client.
 */
export async function getClient(): Promise<PoolClient> {
  const dbPool = getDbPool();
  return await dbPool.connect();
}

/**
 * Executes a query with an authenticated context.
 *
 * @template T
 * @param {string} text - The query string.
 * @param {any[]} [params] - The query parameters.
 * @param {string} [userId] - The user ID for the authenticated context.
 * @returns {Promise<T[]>} The query result rows.
 */
export async function queryWithAuth<T = any>(text: string, params?: any[], userId?: string): Promise<T[]> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (userId) {
      // Set the auth.uid() context for RLS
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      // Also set the role to authenticated to trigger RLS policies
      await client.query(`SET LOCAL ROLE authenticated`);
    } else {
      throw new Error("Unauthorized: Missing userId for RLS context");
    }
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
