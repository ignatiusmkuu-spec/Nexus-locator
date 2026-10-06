import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit, pool, withTransaction } from "../db.js";
import { HttpError, requireAuth, requireCsrf } from "../security.js";

const router = Router();
router.use(requireAuth, requireCsrf);

const metadataSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  deviceType: z.enum(["mobile", "tablet", "desktop", "unknown"]),
  operatingSystem: z.string().trim().min(1).max(80),
  browser: z.string().trim().min(1).max(80),
  screenInfo: z.string().trim().max(40).nullable(),
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  connectionType: z.string().trim().max(40).nullable(),
});

function hashCode(code: string) {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

router.get("/", async (req, res) => {
  const result = await pool.query(
    `SELECT id, display_name, device_type, operating_system, browser, screen_info,
            battery_percent, connection_type, last_seen, created_at,
            (last_seen > NOW() - INTERVAL '90 seconds') AS online
     FROM devices WHERE owner_id = $1 ORDER BY created_at DESC`,
    [req.session.userId],
  );
  res.json({ devices: result.rows });
});

router.post("/register", async (req, res) => {
  const parsed = metadataSchema.extend({ deviceId: z.string().uuid().optional() }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Device details are invalid.");
  const { deviceId, ...metadata } = parsed.data;
  let device;
  if (deviceId) {
    const update = await pool.query(
      `UPDATE devices SET display_name=$1, device_type=$2, operating_system=$3, browser=$4,
              screen_info=$5, battery_percent=$6, connection_type=$7, last_seen=NOW()
       WHERE id=$8 AND owner_id=$9
       RETURNING id, display_name, device_type, operating_system, browser, screen_info, battery_percent, connection_type, last_seen, created_at`,
      [metadata.displayName, metadata.deviceType, metadata.operatingSystem, metadata.browser, metadata.screenInfo,
        metadata.batteryPercent, metadata.connectionType, deviceId, req.session.userId],
    );
    device = update.rows[0];
  }
  if (!device) {
    const result = await pool.query(
      `INSERT INTO devices (owner_id, display_name, device_type, operating_system, browser, screen_info, battery_percent, connection_type, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       RETURNING id, display_name, device_type, operating_system, browser, screen_info, battery_percent, connection_type, last_seen, created_at`,
      [req.session.userId, metadata.displayName, metadata.deviceType, metadata.operatingSystem, metadata.browser,
        metadata.screenInfo, metadata.batteryPercent, metadata.connectionType],
    );
    device = result.rows[0];
    await audit(req.session.userId!, "device_registered", { deviceId: device.id });
  }
  res.status(201).json({ device });
});

router.patch("/:id", async (req, res) => {
  const idSchema = z.string().uuid();
  const name = z.object({ displayName: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if (!idSchema.safeParse(req.params.id).success || !name.success) throw new HttpError(400, "Device name is invalid.");
  const result = await pool.query(
    "UPDATE devices SET display_name=$1 WHERE id=$2 AND owner_id=$3 RETURNING id, display_name",
    [name.data.displayName, req.params.id, req.session.userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Device not found.");
  await audit(req.session.userId!, "device_renamed", { deviceId: req.params.id });
  res.json({ device: result.rows[0] });
});

router.post("/:id/heartbeat", async (req, res) => {
  const meta = metadataSchema.partial().safeParse(req.body);
  if (!z.string().uuid().safeParse(req.params.id).success || !meta.success) throw new HttpError(400, "Device status is invalid.");
  const m = meta.data;
  const result = await pool.query(
    `UPDATE devices SET
       display_name = COALESCE($1, display_name),
       device_type = COALESCE($2, device_type),
       operating_system = COALESCE($3, operating_system),
       browser = COALESCE($4, browser),
       screen_info = CASE WHEN $5::boolean THEN $6 ELSE screen_info END,
       battery_percent = CASE WHEN $7::boolean THEN $8 ELSE battery_percent END,
       connection_type = CASE WHEN $9::boolean THEN $10 ELSE connection_type END,
       last_seen = NOW()
     WHERE id=$11 AND owner_id=$12 RETURNING id`,
    [
      m.displayName ?? null, m.deviceType ?? null, m.operatingSystem ?? null, m.browser ?? null,
      "screenInfo" in m, m.screenInfo ?? null, "batteryPercent" in m, m.batteryPercent ?? null,
      "connectionType" in m, m.connectionType ?? null, req.params.id, req.session.userId,
    ],
  );
  if (!result.rows[0]) throw new HttpError(404, "Device not found.");
  res.json({ ok: true, lastSeen: new Date().toISOString() });
});

router.post("/pairings", async (req, res) => {
  const code = randomBytes(6).toString("hex").toUpperCase();
  await pool.query(
    "INSERT INTO device_pairings (user_id, code_hash, expires_at) VALUES ($1,$2,NOW() + INTERVAL '10 minutes')",
    [req.session.userId, hashCode(code)],
  );
  await audit(req.session.userId!, "device_pair_code_created");
  res.status(201).json({ code, expiresInSeconds: 600 });
});

router.post("/pair", async (req, res) => {
  const parsed = z.object({ code: z.string().trim().min(8).max(20), metadata: metadataSchema }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Pairing code or device details are invalid.");
  const code = parsed.data.code.toUpperCase();
  const digest = hashCode(code);
  const newDevice = await withTransaction(async (client) => {
    const pairing = await client.query(
      `SELECT id FROM device_pairings WHERE user_id=$1 AND code_hash=$2
         AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
      [req.session.userId, digest],
    );
    if (!pairing.rows[0]) throw new HttpError(400, "That pairing code is expired, already used, or does not belong to this account.");
    const m = parsed.data.metadata;
    const inserted = await client.query(
      `INSERT INTO devices (owner_id, display_name, device_type, operating_system, browser, screen_info, battery_percent, connection_type, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       RETURNING id, display_name, device_type, operating_system, browser, screen_info, battery_percent, connection_type, last_seen, created_at`,
      [req.session.userId, m.displayName, m.deviceType, m.operatingSystem, m.browser, m.screenInfo, m.batteryPercent, m.connectionType],
    );
    await client.query("UPDATE device_pairings SET used_at=NOW() WHERE id=$1", [pairing.rows[0].id]);
    await client.query("INSERT INTO audit_logs (actor_id, event_type, device_id) VALUES ($1,'device_paired',$2)", [req.session.userId, inserted.rows[0].id]);
    return inserted.rows[0];
  });
  res.status(201).json({ device: newDevice });
});

router.post("/:id/disconnect", async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, "Device id is invalid.");
  const result = await withTransaction(async (client) => {
    const device = await client.query("SELECT id FROM devices WHERE id=$1 AND owner_id=$2 FOR UPDATE", [req.params.id, req.session.userId]);
    if (!device.rows[0]) throw new HttpError(404, "Device not found.");
    await client.query(
      `UPDATE permissions SET revoked_at=NOW() WHERE revoked_at IS NULL AND session_id IN
         (SELECT id FROM location_sessions WHERE device_id=$1 AND stopped_at IS NULL)`,
      [req.params.id],
    );
    await client.query("UPDATE location_sessions SET stopped_at=NOW(), stop_reason='device_disconnected' WHERE device_id=$1 AND stopped_at IS NULL", [req.params.id]);
    await client.query("INSERT INTO audit_logs (actor_id, event_type, device_id) VALUES ($1,'device_disconnected',$2)", [req.session.userId, req.params.id]);
    return true;
  });
  res.json({ ok: result });
});

router.delete("/:id", async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, "Device id is invalid.");
  const result = await pool.query("DELETE FROM devices WHERE id=$1 AND owner_id=$2 RETURNING id", [req.params.id, req.session.userId]);
  if (!result.rows[0]) throw new HttpError(404, "Device not found.");
  await audit(req.session.userId!, "device_removed", { metadata: { deviceRemoved: true } });
  res.json({ ok: true });
});

export default router;

