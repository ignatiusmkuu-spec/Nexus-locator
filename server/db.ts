import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Connect the Replit PostgreSQL database before starting Nexus Locator.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: true } : undefined,
});

pool.on("error", (error) => {
  console.error("Unexpected idle database connection error:", error.message);
});

export async function audit(
  actorId: string | null,
  eventType: string,
  options: { deviceId?: string | null; sessionId?: string | null; metadata?: Record<string, unknown> } = {},
) {
  await pool.query(
    `INSERT INTO audit_logs (actor_id, event_type, device_id, session_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, eventType, options.deviceId ?? null, options.sessionId ?? null, JSON.stringify(options.metadata ?? {})],
  );
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

