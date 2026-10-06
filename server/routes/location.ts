import { Router } from "express";
import type { Server } from "socket.io";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, pool, withTransaction } from "../db.js";
import { HttpError, requireAuth, requireCsrf } from "../security.js";
import { decryptLocation, encryptLocation } from "../location-crypto.js";

const router = Router();
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const currentDeviceSchema = z.object({
  deviceId: z.string().uuid().optional(),
  device: z.object({
    displayName: z.string().trim().min(1).max(80),
    deviceType: z.enum(["mobile", "tablet", "desktop", "unknown"]),
    operatingSystem: z.string().trim().min(1).max(80),
    browser: z.string().trim().min(1).max(80),
    screenInfo: z.string().trim().max(40).nullable(),
    batteryPercent: z.number().int().min(0).max(100).nullable(),
    connectionType: z.string().trim().max(40).nullable(),
  }),
});
const pointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(1_000_000),
  altitude: z.number().nullable(),
  heading: z.number().min(0).max(360).nullable(),
  speed: z.number().min(0).nullable(),
  updateKey: z.string().uuid(),
});
const invitationTargetSchema = z.string().trim().min(5).max(320).refine(
  (value) => value.includes("@") ? z.string().email().safeParse(value).success : /^\+?[0-9][0-9\s().-]{5,24}$/.test(value),
  "Enter a valid email address or phone number.",
);
const routeId = z.string().uuid();

function expiresAt(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function upsertCurrentDevice(client: import("pg").PoolClient, userId: string, input: z.infer<typeof currentDeviceSchema>) {
  if (input.deviceId) {
    const found = await client.query(
      `UPDATE devices SET display_name=$1, device_type=$2, operating_system=$3, browser=$4,
              screen_info=$5, battery_percent=$6, connection_type=$7, last_seen=NOW()
       WHERE id=$8 AND owner_id=$9 RETURNING id`,
      [input.device.displayName, input.device.deviceType, input.device.operatingSystem, input.device.browser,
        input.device.screenInfo, input.device.batteryPercent, input.device.connectionType, input.deviceId, userId],
    );
    if (found.rows[0]) return input.deviceId;
  }
  const created = await client.query(
    `INSERT INTO devices (owner_id, display_name, device_type, operating_system, browser, screen_info, battery_percent, connection_type, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
    [userId, input.device.displayName, input.device.deviceType, input.device.operatingSystem, input.device.browser,
      input.device.screenInfo, input.device.batteryPercent, input.device.connectionType],
  );
  return created.rows[0].id as string;
}

async function writeInitialPoint(client: import("pg").PoolClient, sessionId: string, point: z.infer<typeof pointSchema>, retentionHours: number) {
  const encrypted = encryptLocation(point);
  await client.query(
    `INSERT INTO location_points
       (session_id, update_key, location_ciphertext, location_iv, location_auth_tag, recorded_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,NOW(),$6)`,
    [sessionId, point.updateKey, encrypted.ciphertext, encrypted.iv, encrypted.authTag, expiresAt(retentionHours)],
  );
}

async function broadcastNewPoint(io: Server, sessionId: string, payload: unknown) {
  const result = await pool.query(
    "SELECT owner_id, viewer_id FROM location_sessions WHERE id=$1 AND stopped_at IS NULL",
    [sessionId],
  );
  if (!result.rows[0]) return;
  io.to(`user:${result.rows[0].owner_id}`).emit("location:update", { sessionId, point: payload });
  io.to(`user:${result.rows[0].viewer_id}`).emit("location:update", { sessionId, point: payload });
}

export function createLocationRouter(io: Server, retentionHours: number) {
  router.get("/invitations/:token", async (req, res) => {
    const token = z.string().regex(/^[a-f0-9]{64}$/i).safeParse(req.params.token);
    if (!token.success) throw new HttpError(404, "This invitation is not available.");
    const result = await pool.query(
      `SELECT i.id, i.target, i.expires_at, i.accepted_at, i.revoked_at,
              u.display_name AS requester_name
       FROM invitations i JOIN users u ON u.id=i.requester_id
       WHERE i.token_hash=$1 AND i.expires_at > NOW() AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
      [tokenHash(token.data)],
    );
    if (!result.rows[0]) throw new HttpError(404, "This invitation has expired or has already been used.");
    const row = result.rows[0];
    const maskedTarget = row.target.includes("@")
      ? `${row.target.slice(0, 1)}•••@${row.target.split("@").at(-1)}`
      : `•••• ${row.target.replace(/\D/g, "").slice(-3)}`;
    res.json({ invitation: { id: row.id, requesterName: row.requester_name, target: maskedTarget, expiresAt: row.expires_at } });
  });

  const protectedRouter = Router();
  protectedRouter.use(requireAuth, requireCsrf);

  protectedRouter.post("/invitations", async (req, res) => {
    const parsed = z.object({ target: invitationTargetSchema }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invitation details are invalid.");
    const token = randomBytes(32).toString("hex");
    const expiry = expiresAt(48);
    const result = await pool.query(
      `INSERT INTO invitations (requester_id, target, token_hash, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING id, target, expires_at`,
      [req.session.userId, parsed.data.target, tokenHash(token), expiry],
    );
    await audit(req.session.userId!, "invitation_created");
    res.status(201).json({ invitation: { ...result.rows[0], token } });
  });

  protectedRouter.get("/invitations", async (req, res) => {
    const result = await pool.query(
      `SELECT id, target, created_at, expires_at, accepted_at, revoked_at,
              (expires_at > NOW() AND accepted_at IS NULL AND revoked_at IS NULL) AS usable
       FROM invitations WHERE requester_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.session.userId],
    );
    res.json({ invitations: result.rows });
  });

  protectedRouter.delete("/invitations/:id", async (req, res) => {
    if (!routeId.safeParse(req.params.id).success) throw new HttpError(400, "Invitation id is invalid.");
    const result = await pool.query(
      "UPDATE invitations SET revoked_at=NOW() WHERE id=$1 AND requester_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id",
      [req.params.id, req.session.userId],
    );
    if (!result.rows[0]) throw new HttpError(404, "This invitation is no longer available.");
    await audit(req.session.userId!, "invitation_revoked");
    res.json({ ok: true });
  });

  protectedRouter.post("/invitations/:token/approve", async (req, res) => {
    const token = z.string().regex(/^[a-f0-9]{64}$/i).safeParse(req.params.token);
    const deviceInput = currentDeviceSchema.safeParse(req.body?.currentDevice);
    const point = pointSchema.safeParse(req.body?.point);
    if (!token.success || !deviceInput.success || !point.success) throw new HttpError(400, "Device details or location are invalid.");
    const created = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT id, requester_id FROM invitations WHERE token_hash=$1 AND expires_at > NOW()
           AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
        [tokenHash(token.data)],
      );
      if (!found.rows[0]) throw new HttpError(404, "This invitation has expired or has already been used.");
      if (found.rows[0].requester_id === req.session.userId) throw new HttpError(400, "You cannot approve your own invitation.");
      const deviceId = await upsertCurrentDevice(client, req.session.userId!, deviceInput.data);
      const share = await client.query(
        `INSERT INTO location_sessions (device_id, owner_id, viewer_id, invitation_id)
         VALUES ($1,$2,$3,$4) RETURNING id, started_at`,
        [deviceId, req.session.userId, found.rows[0].requester_id, found.rows[0].id],
      );
      await client.query(
        "INSERT INTO permissions (session_id, granted_by_user_id) VALUES ($1,$2)",
        [share.rows[0].id, req.session.userId],
      );
      await writeInitialPoint(client, share.rows[0].id, point.data, retentionHours);
      await client.query("UPDATE invitations SET accepted_at=NOW() WHERE id=$1", [found.rows[0].id]);
      await client.query(
        "INSERT INTO audit_logs (actor_id, event_type, device_id, session_id) VALUES ($1,'sharing_started',$2,$3)",
        [req.session.userId, deviceId, share.rows[0].id],
      );
      return { ...share.rows[0], deviceId, viewerId: found.rows[0].requester_id };
    });
    await broadcastNewPoint(io, created.id, point.data);
    res.status(201).json({ share: { id: created.id, deviceId: created.deviceId, startedAt: created.started_at }, deviceId: created.deviceId });
  });

  protectedRouter.post("/invitations/:token/decline", async (req, res) => {
    const token = z.string().regex(/^[a-f0-9]{64}$/i).safeParse(req.params.token);
    if (!token.success) throw new HttpError(404, "This invitation is not available.");
    const result = await pool.query(
      `UPDATE invitations SET revoked_at=NOW()
       WHERE token_hash=$1 AND requester_id<>$2 AND expires_at > NOW()
         AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [tokenHash(token.data), req.session.userId],
    );
    if (!result.rows[0]) throw new HttpError(404, "This invitation has expired or has already been used.");
    await audit(req.session.userId!, "invitation_declined");
    res.json({ ok: true });
  });

  protectedRouter.post("/shares/start", async (req, res) => {
    const deviceInput = currentDeviceSchema.safeParse(req.body?.currentDevice);
    const point = pointSchema.safeParse(req.body?.point);
    if (!deviceInput.success || !point.success) throw new HttpError(400, "Device details or location are invalid.");
    const created = await withTransaction(async (client) => {
      const deviceId = await upsertCurrentDevice(client, req.session.userId!, deviceInput.data);
      const active = await client.query(
        `SELECT id FROM location_sessions WHERE device_id=$1 AND viewer_id=$2
           AND stopped_at IS NULL FOR UPDATE`,
        [deviceId, req.session.userId],
      );
      if (active.rows[0]) throw new HttpError(409, "Location sharing is already active on this device.");
      const share = await client.query(
        `INSERT INTO location_sessions (device_id, owner_id, viewer_id)
         VALUES ($1,$2,$2) RETURNING id, started_at`,
        [deviceId, req.session.userId],
      );
      await client.query("INSERT INTO permissions (session_id, granted_by_user_id) VALUES ($1,$2)", [share.rows[0].id, req.session.userId]);
      await writeInitialPoint(client, share.rows[0].id, point.data, retentionHours);
      await client.query(
        "INSERT INTO audit_logs (actor_id, event_type, device_id, session_id) VALUES ($1,'sharing_started',$2,$3)",
        [req.session.userId, deviceId, share.rows[0].id],
      );
      return { ...share.rows[0], deviceId };
    });
    await broadcastNewPoint(io, created.id, point.data);
    res.status(201).json({ share: { id: created.id, deviceId: created.deviceId, startedAt: created.started_at }, deviceId: created.deviceId });
  });

  protectedRouter.post("/devices/:id/location", async (req, res) => {
    if (!routeId.safeParse(req.params.id).success) throw new HttpError(400, "Device id is invalid.");
    const point = pointSchema.safeParse(req.body);
    if (!point.success) throw new HttpError(400, point.error.issues[0]?.message ?? "Location update is invalid.");
    const encrypted = encryptLocation(point.data);
    const device = await pool.query("UPDATE devices SET last_seen=NOW() WHERE id=$1 AND owner_id=$2 RETURNING id", [req.params.id, req.session.userId]);
    if (!device.rows[0]) throw new HttpError(404, "Device not found.");
    const allowed = await pool.query(
      `SELECT s.id FROM location_sessions s JOIN permissions p ON p.session_id=s.id
       WHERE s.device_id=$1 AND s.owner_id=$2 AND s.stopped_at IS NULL AND p.revoked_at IS NULL`,
      [req.params.id, req.session.userId],
    );
    if (!allowed.rows.length) throw new HttpError(403, "There is no active, approved sharing session for this device.");
    const written = await pool.query(
      `INSERT INTO location_points (session_id, update_key, location_ciphertext, location_iv, location_auth_tag, recorded_at, expires_at)
       SELECT s.id, $2, $3, $4, $5, NOW(), $6
       FROM location_sessions s JOIN permissions p ON p.session_id=s.id
       WHERE s.device_id=$1 AND s.owner_id=$10 AND s.stopped_at IS NULL AND p.revoked_at IS NULL
       ON CONFLICT (session_id, update_key) DO NOTHING
       RETURNING session_id`,
      [req.params.id, point.data.updateKey, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
        expiresAt(retentionHours), req.session.userId],
    );
    if (!written.rows.length) return res.json({ ok: true, duplicate: true, acceptedSessions: allowed.rows.length });
    const payload = { ...point.data, recordedAt: new Date().toISOString() };
    for (const row of written.rows) await broadcastNewPoint(io, row.session_id, payload);
    res.json({ ok: true, acceptedSessions: written.rows.length, recordedAt: payload.recordedAt });
  });

  protectedRouter.get("/shares", async (req, res) => {
    const result = await pool.query(
      `SELECT s.id, s.device_id, s.owner_id, s.viewer_id, s.started_at, s.stopped_at, s.stop_reason,
              owner.display_name AS owner_name, viewer.display_name AS viewer_name,
              d.display_name AS device_name, d.device_type, d.operating_system, d.browser,
              d.battery_percent, d.connection_type, d.last_seen,
              (d.last_seen > NOW() - INTERVAL '90 seconds') AS device_online,
              p.revoked_at,
              CASE WHEN (s.owner_id=$1 OR (s.stopped_at IS NULL AND p.revoked_at IS NULL))
                THEN latest.location_ciphertext ELSE NULL END AS location_ciphertext,
              CASE WHEN (s.owner_id=$1 OR (s.stopped_at IS NULL AND p.revoked_at IS NULL))
                THEN latest.location_iv ELSE NULL END AS location_iv,
              CASE WHEN (s.owner_id=$1 OR (s.stopped_at IS NULL AND p.revoked_at IS NULL))
                THEN latest.location_auth_tag ELSE NULL END AS location_auth_tag,
              CASE WHEN (s.owner_id=$1 OR (s.stopped_at IS NULL AND p.revoked_at IS NULL))
                THEN latest.recorded_at ELSE NULL END AS recorded_at
       FROM location_sessions s
       JOIN permissions p ON p.session_id=s.id
       JOIN users owner ON owner.id=s.owner_id
       JOIN users viewer ON viewer.id=s.viewer_id
       JOIN devices d ON d.id=s.device_id
       LEFT JOIN LATERAL (
         SELECT location_ciphertext, location_iv, location_auth_tag, recorded_at
         FROM location_points WHERE session_id=s.id AND expires_at > NOW()
         ORDER BY recorded_at DESC LIMIT 1
       ) latest ON TRUE
       WHERE (s.owner_id=$1 OR s.viewer_id=$1) AND s.started_at > NOW() - INTERVAL '14 days'
       ORDER BY s.started_at DESC LIMIT 100`,
      [req.session.userId],
    );
    const shares = result.rows.map((row) => {
      const { location_ciphertext: ciphertext, location_iv: iv, location_auth_tag: authTag, ...rest } = row;
      if (!ciphertext || !iv || !authTag) return rest;
      return { ...rest, ...decryptLocation(ciphertext, iv, authTag) };
    });
    const accessible = result.rows.filter((row) => row.location_ciphertext !== null);
    for (const row of accessible) {
      await audit(req.session.userId!, "location_accessed", { deviceId: row.device_id, sessionId: row.id });
    }
    res.json({ shares });
  });

  protectedRouter.get("/shares/:id/history", async (req, res) => {
    if (!routeId.safeParse(req.params.id).success) throw new HttpError(400, "Sharing session id is invalid.");
    const access = await pool.query(
      `SELECT s.id, s.device_id, s.owner_id, s.viewer_id, s.stopped_at, p.revoked_at
       FROM location_sessions s JOIN permissions p ON p.session_id=s.id
       WHERE s.id=$1 AND (s.owner_id=$2 OR s.viewer_id=$2)`,
      [req.params.id, req.session.userId],
    );
    const share = access.rows[0];
    if (!share || (share.owner_id !== req.session.userId && (share.stopped_at || share.revoked_at))) {
      throw new HttpError(404, "This location history is no longer shared with you.");
    }
    const points = await pool.query(
      `SELECT location_ciphertext, location_iv, location_auth_tag, recorded_at
       FROM location_points WHERE session_id=$1 AND expires_at > NOW()
       ORDER BY recorded_at DESC LIMIT 100`,
      [req.params.id],
    );
    await pool.query("UPDATE location_sessions SET last_access_at=NOW() WHERE id=$1", [req.params.id]);
    await audit(req.session.userId!, "location_history_accessed", { deviceId: share.device_id, sessionId: req.params.id });
    res.json({
      points: points.rows.map((row) => ({
        ...decryptLocation(row.location_ciphertext, row.location_iv, row.location_auth_tag),
        recordedAt: row.recorded_at,
      })),
    });
  });

  protectedRouter.post("/shares/:id/stop", async (req, res) => {
    if (!routeId.safeParse(req.params.id).success) throw new HttpError(400, "Sharing session id is invalid.");
    const result = await withTransaction(async (client) => {
      const stopped = await client.query(
        `UPDATE location_sessions SET stopped_at=NOW(), stop_reason='access_revoked'
         WHERE id=$1 AND stopped_at IS NULL AND (owner_id=$2 OR viewer_id=$2)
         RETURNING id, device_id, owner_id, viewer_id`,
        [req.params.id, req.session.userId],
      );
      if (!stopped.rows[0]) throw new HttpError(404, "This sharing session is already stopped or unavailable.");
      await client.query("UPDATE permissions SET revoked_at=NOW() WHERE session_id=$1 AND revoked_at IS NULL", [req.params.id]);
      await client.query(
        "INSERT INTO audit_logs (actor_id, event_type, device_id, session_id) VALUES ($1,'sharing_stopped',$2,$3)",
        [req.session.userId, stopped.rows[0].device_id, req.params.id],
      );
      return stopped.rows[0];
    });
    io.to(`user:${result.owner_id}`).emit("sharing:revoked", { sessionId: result.id });
    io.to(`user:${result.viewer_id}`).emit("sharing:revoked", { sessionId: result.id });
    res.json({ ok: true });
  });

  protectedRouter.post("/privacy/stop-all", async (req, res) => {
    const stopped = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE location_sessions SET stopped_at=NOW(), stop_reason='stop_all'
         WHERE stopped_at IS NULL AND (owner_id=$1 OR viewer_id=$1)
         RETURNING id, device_id, owner_id, viewer_id`,
        [req.session.userId],
      );
      await client.query(
        `UPDATE permissions SET revoked_at=NOW() WHERE revoked_at IS NULL
         AND session_id IN (SELECT id FROM location_sessions WHERE stop_reason='stop_all' AND stopped_at IS NOT NULL AND (owner_id=$1 OR viewer_id=$1))`,
        [req.session.userId],
      );
      for (const item of result.rows) {
        await client.query(
          "INSERT INTO audit_logs (actor_id, event_type, device_id, session_id) VALUES ($1,'sharing_stopped',$2,$3)",
          [req.session.userId, item.device_id, item.id],
        );
      }
      return result.rows;
    });
    for (const item of stopped) {
      io.to(`user:${item.owner_id}`).emit("sharing:revoked", { sessionId: item.id });
      io.to(`user:${item.viewer_id}`).emit("sharing:revoked", { sessionId: item.id });
    }
    await audit(req.session.userId!, "all_sharing_stopped");
    res.json({ ok: true, stoppedCount: stopped.length });
  });

  protectedRouter.delete("/privacy/location-data", async (req, res) => {
    const result = await pool.query(
      `DELETE FROM location_points WHERE session_id IN
       (SELECT id FROM location_sessions WHERE owner_id=$1 OR viewer_id=$1)`,
      [req.session.userId],
    );
    await audit(req.session.userId!, "location_data_deleted");
    res.json({ ok: true, deletedPoints: result.rowCount ?? 0 });
  });

  protectedRouter.get("/privacy/audit", async (req, res) => {
    const result = await pool.query(
      `SELECT id, event_type, created_at, metadata,
              (session_id IS NOT NULL) AS related_to_sharing
       FROM audit_logs WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.session.userId],
    );
    res.json({ events: result.rows });
  });

  protectedRouter.post("/reports", async (req, res) => {
    const parsed = z.object({
      category: z.enum(["unauthorized_access", "unsafe_invitation", "account_security", "other"]),
      details: z.string().trim().min(10).max(2000),
    }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Choose a report type and include at least 10 characters.");
    await pool.query(
      "INSERT INTO abuse_reports (reporter_id, category, details) VALUES ($1,$2,$3)",
      [req.session.userId, parsed.data.category, parsed.data.details],
    );
    await audit(req.session.userId!, "abuse_report_submitted");
    res.status(201).json({ ok: true });
  });

  router.use(protectedRouter);
  return router;
}

export default router;

