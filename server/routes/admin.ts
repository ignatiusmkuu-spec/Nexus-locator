import { Router } from "express";
import { z } from "zod";
import { audit, pool, withTransaction } from "../db.js";
import { HttpError, requireAdmin, requireCsrf } from "../security.js";
import type { Server } from "socket.io";

export function createAdminRouter(io: Server, requestMetrics: Map<string, number>) {
  const router = Router();
  router.use(requireAdmin, requireCsrf);

  router.get("/overview", async (_req, res) => {
    const [users, devices, shares, reports, auditCount, health] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE disabled_at IS NOT NULL)::int AS disabled FROM users"),
      pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '90 seconds')::int AS online FROM devices"),
      pool.query("SELECT COUNT(*)::int AS active FROM location_sessions s JOIN permissions p ON p.session_id=s.id WHERE s.stopped_at IS NULL AND p.revoked_at IS NULL"),
      pool.query("SELECT COUNT(*) FILTER (WHERE status='open')::int AS open FROM abuse_reports"),
      pool.query("SELECT COUNT(*)::int AS total FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT NOW() AS checked_at"),
    ]);
    res.json({
      users: users.rows[0], devices: devices.rows[0], shares: shares.rows[0], reports: reports.rows[0],
      securityEvents24h: auditCount.rows[0].total, database: { healthy: Boolean(health.rows[0]), checkedAt: health.rows[0]?.checked_at },
      uptimeSeconds: Math.floor(process.uptime()),
      apiUsage: [...requestMetrics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([route, requests]) => ({ route, requests })),
    });
  });

  router.get("/users", async (_req, res) => {
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.disabled_at, u.created_at,
              COUNT(DISTINCT d.id)::int AS device_count,
              COUNT(DISTINCT s.id) FILTER (WHERE s.stopped_at IS NULL AND p.revoked_at IS NULL)::int AS active_shares
       FROM users u LEFT JOIN devices d ON d.owner_id=u.id
       LEFT JOIN location_sessions s ON s.owner_id=u.id
       LEFT JOIN permissions p ON p.session_id=s.id
       GROUP BY u.id ORDER BY u.created_at DESC LIMIT 300`,
    );
    res.json({ users: result.rows });
  });

  router.patch("/users/:id", async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, "Account id is invalid.");
    const parsed = z.object({ disabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Account status is invalid.");
    if (parsed.data.disabled && req.params.id === req.session.userId) throw new HttpError(400, "You cannot disable your own administrator account.");
    const outcome = await withTransaction(async (client) => {
      const found = await client.query("SELECT id, role, disabled_at FROM users WHERE id=$1 FOR UPDATE", [req.params.id]);
      const target = found.rows[0];
      if (!target) throw new HttpError(404, "Account not found.");
      if (parsed.data.disabled && target.role === "admin" && !target.disabled_at) {
        const admins = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin' AND disabled_at IS NULL");
        if (admins.rows[0].count <= 1) throw new HttpError(409, "Promote another administrator before disabling the last active administrator.");
      }
      await client.query("UPDATE users SET disabled_at=$1 WHERE id=$2", [parsed.data.disabled ? new Date() : null, req.params.id]);
      if (parsed.data.disabled) {
        await client.query(
          `UPDATE permissions SET revoked_at=NOW() WHERE revoked_at IS NULL AND session_id IN
           (SELECT id FROM location_sessions WHERE stopped_at IS NULL AND (owner_id=$1 OR viewer_id=$1))`,
          [req.params.id],
        );
        await client.query("UPDATE location_sessions SET stopped_at=NOW(), stop_reason='admin_disabled' WHERE stopped_at IS NULL AND (owner_id=$1 OR viewer_id=$1)", [req.params.id]);
        await client.query("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
      }
      await client.query(
        "INSERT INTO audit_logs (actor_id, event_type, metadata) VALUES ($1,$2,$3::jsonb)",
        [req.session.userId, parsed.data.disabled ? "admin_account_disabled" : "admin_account_enabled", JSON.stringify({ targetUserId: req.params.id })],
      );
      return { id: target.id, disabledAt: parsed.data.disabled ? new Date() : null };
    });
    if (parsed.data.disabled) {
      io.emit("admin:account-disabled", { userId: req.params.id });
    }
    res.json({ user: outcome });
  });

  router.get("/devices", async (_req, res) => {
    const result = await pool.query(
      `SELECT d.id, d.display_name, d.device_type, d.operating_system, d.browser, d.battery_percent,
              d.connection_type, d.last_seen, d.created_at, u.email AS owner_email,
              (d.last_seen > NOW() - INTERVAL '90 seconds') AS online,
              COUNT(s.id) FILTER (WHERE s.stopped_at IS NULL AND p.revoked_at IS NULL)::int AS active_shares
       FROM devices d JOIN users u ON u.id=d.owner_id
       LEFT JOIN location_sessions s ON s.device_id=d.id LEFT JOIN permissions p ON p.session_id=s.id
       GROUP BY d.id,u.email ORDER BY d.created_at DESC LIMIT 300`,
    );
    res.json({ devices: result.rows });
  });

  router.get("/sharing", async (_req, res) => {
    const result = await pool.query(
      `SELECT s.id, s.started_at, s.stopped_at, s.stop_reason,
              d.id AS device_id, d.display_name AS device_name, d.device_type,
              owner.email AS owner_email, viewer.email AS viewer_email
       FROM location_sessions s
       JOIN permissions p ON p.session_id=s.id
       JOIN devices d ON d.id=s.device_id
       JOIN users owner ON owner.id=s.owner_id
       JOIN users viewer ON viewer.id=s.viewer_id
       WHERE s.started_at > NOW() - INTERVAL '30 days'
       ORDER BY s.started_at DESC LIMIT 300`,
    );
    res.json({ shares: result.rows });
  });

  router.post("/sharing/:id/revoke", async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, "Sharing session id is invalid.");
    const result = await withTransaction(async (client) => {
      const stopped = await client.query(
        `UPDATE location_sessions SET stopped_at=NOW(), stop_reason='admin_revoked'
         WHERE id=$1 AND stopped_at IS NULL RETURNING id, device_id, owner_id, viewer_id`,
        [req.params.id],
      );
      if (!stopped.rows[0]) throw new HttpError(404, "Active sharing session not found.");
      await client.query("UPDATE permissions SET revoked_at=NOW() WHERE session_id=$1 AND revoked_at IS NULL", [req.params.id]);
      await client.query(
        "INSERT INTO audit_logs (actor_id, event_type, device_id, session_id) VALUES ($1,'admin_sharing_revoked',$2,$3)",
        [req.session.userId, stopped.rows[0].device_id, req.params.id],
      );
      return stopped.rows[0];
    });
    io.to(`user:${result.owner_id}`).emit("sharing:revoked", { sessionId: result.id });
    io.to(`user:${result.viewer_id}`).emit("sharing:revoked", { sessionId: result.id });
    res.json({ ok: true });
  });

  router.get("/audit", async (_req, res) => {
    const result = await pool.query(
      `SELECT a.id, a.event_type, a.created_at, a.metadata,
              u.email AS actor_email, d.display_name AS device_name
       FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
       LEFT JOIN devices d ON d.id=a.device_id
       ORDER BY a.created_at DESC LIMIT 300`,
    );
    res.json({ events: result.rows });
  });

  router.get("/reports", async (_req, res) => {
    const result = await pool.query(
      `SELECT r.id, r.category, r.details, r.status, r.created_at, r.resolved_at, u.email AS reporter_email
       FROM abuse_reports r JOIN users u ON u.id=r.reporter_id
       ORDER BY CASE WHEN r.status='open' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 300`,
    );
    res.json({ reports: result.rows });
  });

  router.patch("/reports/:id", async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, "Report id is invalid.");
    const parsed = z.object({ status: z.enum(["open", "reviewing", "resolved", "dismissed"]) }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Report status is invalid.");
    const result = await pool.query(
      "UPDATE abuse_reports SET status=$1, resolved_at=CASE WHEN $1 IN ('resolved','dismissed') THEN NOW() ELSE NULL END WHERE id=$2 RETURNING id,status",
      [parsed.data.status, req.params.id],
    );
    if (!result.rows[0]) throw new HttpError(404, "Report not found.");
    await audit(req.session.userId!, "admin_report_updated");
    res.json({ report: result.rows[0] });
  });

  return router;
}

