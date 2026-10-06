import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Server } from "socket.io";
import { pool, audit, withTransaction } from "../db.js";
import { HttpError, issueCsrfToken, requireAuth, requireCsrf } from "../security.js";

const router = Router();
const emailSchema = z.string().trim().email().max(320).transform((value) => value.toLowerCase());
const signupSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(10).max(128),
});
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });
const publicUser = (row: any) => ({ id: row.id, email: row.email, displayName: row.display_name, role: row.role, createdAt: row.created_at });

function saveSession(req: import("express").Request) {
  return new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

function regenerateSession(req: import("express").Request) {
  return new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

router.get("/csrf", (req, res) => res.json({ csrfToken: issueCsrfToken(req) }));

router.get("/session", async (req, res) => {
  if (!req.session.userId) return res.json({ user: null, csrfToken: issueCsrfToken(req) });
  const result = await pool.query("SELECT id, email, display_name, role, created_at, disabled_at FROM users WHERE id = $1", [req.session.userId]);
  if (!result.rows[0] || result.rows[0].disabled_at) {
    await regenerateSession(req);
    req.session.csrfToken = crypto.randomUUID();
    await saveSession(req);
    return res.json({ user: null, csrfToken: req.session.csrfToken });
  }
  req.session.userRole = result.rows[0].role;
  res.json({ user: publicUser(result.rows[0]), csrfToken: issueCsrfToken(req) });
});

router.post("/signup", requireCsrf, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Check the signup details.");
  const { email, displayName, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const created = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, display_name, role, created_at`,
      [email, displayName, passwordHash],
    );
    await client.query("INSERT INTO audit_logs (actor_id, event_type) VALUES ($1, 'account_created')", [result.rows[0].id]);
    return result.rows[0];
  }).catch((error: any) => {
    if (error?.code === "23505") throw new HttpError(409, "An account with this email already exists.");
    throw error;
  });
  await regenerateSession(req);
  req.session.userId = created.id;
  req.session.userRole = created.role;
  req.session.csrfToken = crypto.randomUUID();
  await saveSession(req);
  res.status(201).json({ user: publicUser(created), csrfToken: req.session.csrfToken });
});

router.post("/login", requireCsrf, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Enter a valid email and password.");
  const result = await pool.query("SELECT id, email, display_name, role, created_at, password_hash, disabled_at FROM users WHERE email = $1", [parsed.data.email]);
  const user = result.rows[0];
  if (!user || user.disabled_at || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    throw new HttpError(401, "Email or password is incorrect.");
  }
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.userRole = user.role;
  req.session.csrfToken = crypto.randomUUID();
  await saveSession(req);
  await audit(user.id, "account_login");
  res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
});

router.post("/logout", requireAuth, requireCsrf, async (req, res) => {
  const userId = req.session.userId!;
  await audit(userId, "account_logout");
  globalIo?.in(`user:${userId}`).disconnectSockets(true);
  await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
  res.clearCookie("nexus.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true });
});

router.post("/logout-all", requireAuth, requireCsrf, async (req, res) => {
  const userId = req.session.userId!;
  await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  await audit(userId, "sessions_revoked");
  globalIo?.in(`user:${userId}`).disconnectSockets(true);
  await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
  res.clearCookie("nexus.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true });
});

router.patch("/account", requireAuth, requireCsrf, async (req, res) => {
  const parsed = z.object({ displayName: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Enter a name up to 80 characters.");
  const result = await pool.query(
    "UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, email, display_name, role, created_at",
    [parsed.data.displayName, req.session.userId],
  );
  res.json({ user: publicUser(result.rows[0]) });
});

router.post("/account/password", requireAuth, requireCsrf, async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(10).max(128) }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "The new password must be at least 10 characters.");
  const found = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.session.userId]);
  if (!found.rows[0] || !(await bcrypt.compare(parsed.data.currentPassword, found.rows[0].password_hash))) {
    throw new HttpError(401, "Current password is incorrect.");
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, req.session.userId]);
  await pool.query("DELETE FROM sessions WHERE user_id = $1", [req.session.userId]);
  await audit(req.session.userId!, "password_changed");
  globalIo?.in(`user:${req.session.userId}`).disconnectSockets(true);
  await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
  res.clearCookie("nexus.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true, reauthenticate: true });
});

router.delete("/account", requireAuth, requireCsrf, async (req, res) => {
  const parsed = z.object({ password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Confirm your password to delete this account.");
  const found = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.session.userId]);
  if (!found.rows[0] || !(await bcrypt.compare(parsed.data.password, found.rows[0].password_hash))) {
    throw new HttpError(401, "Password is incorrect.");
  }
  const userId = req.session.userId!;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE permissions p SET revoked_at = NOW()
       FROM location_sessions s
       WHERE p.session_id = s.id AND p.revoked_at IS NULL AND (s.owner_id = $1 OR s.viewer_id = $1)`,
      [userId],
    );
    await client.query("UPDATE location_sessions SET stopped_at = NOW(), stop_reason = 'account_deleted' WHERE stopped_at IS NULL AND (owner_id = $1 OR viewer_id = $1)", [userId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
  });
  globalIo?.in(`user:${userId}`).disconnectSockets(true);
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie("nexus.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true });
});

let globalIo: Server | undefined;
export function createAuthRouter(io: Server) {
  globalIo = io;
  return router;
}
export default router;

