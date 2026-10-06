import session from "express-session";
import type { Pool } from "pg";

export class PostgresSessionStore extends session.Store {
  constructor(private pool: Pool) {
    super();
  }

  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void) {
    this.pool.query(
      "SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()",
      [sid],
    ).then((result) => callback(null, result.rows[0]?.sess ?? null), callback);
  }

  set(sid: string, sess: session.SessionData, callback?: (err?: unknown) => void) {
    const expire = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 8 * 60 * 60 * 1000);
    const userId = typeof sess.userId === "string" ? sess.userId : null;
    this.pool.query(
      `INSERT INTO sessions (sid, sess, expire, user_id)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire, user_id = EXCLUDED.user_id`,
      [sid, JSON.stringify(sess), expire, userId],
    ).then(() => callback?.(), (error) => callback?.(error));
  }

  destroy(sid: string, callback?: (err?: unknown) => void) {
    this.pool.query("DELETE FROM sessions WHERE sid = $1", [sid])
      .then(() => callback?.(), (error) => callback?.(error));
  }

  touch(sid: string, sess: session.SessionData, callback?: (err?: unknown) => void) {
    const expire = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.pool.query("UPDATE sessions SET expire = $2 WHERE sid = $1", [sid, expire])
      .then(() => callback?.(), (error) => callback?.(error));
  }
}

