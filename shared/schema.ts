import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 16 }).notNull().default("member"),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { withTimezone: true }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
}, (table) => [index("sessions_expire_idx").on(table.expire), index("sessions_user_idx").on(table.userId)]);

export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  deviceType: varchar("device_type", { length: 24 }).notNull(),
  operatingSystem: varchar("operating_system", { length: 80 }).notNull(),
  browser: varchar("browser", { length: 80 }).notNull(),
  screenInfo: varchar("screen_info", { length: 40 }),
  batteryPercent: integer("battery_percent"),
  connectionType: varchar("connection_type", { length: 40 }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("devices_owner_idx").on(table.ownerId)]);

export const devicePairings = pgTable("device_pairings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("device_pairings_expiry_idx").on(table.expiresAt)]);

export const invitations = pgTable("invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  requesterId: uuid("requester_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  target: varchar("target", { length: 320 }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("invitations_requester_idx").on(table.requesterId)]);

export const locationSessions = pgTable("location_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  viewerId: uuid("viewer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  invitationId: uuid("invitation_id").references(() => invitations.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  stopReason: varchar("stop_reason", { length: 24 }),
  lastAccessAt: timestamp("last_access_at", { withTimezone: true }),
}, (table) => [
  index("location_sessions_owner_idx").on(table.ownerId, table.stoppedAt),
  index("location_sessions_viewer_idx").on(table.viewerId, table.stoppedAt),
]);

export const permissions = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().unique().references(() => locationSessions.id, { onDelete: "cascade" }),
  grantedByUserId: uuid("granted_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  consentedAt: timestamp("consented_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const locationPoints = pgTable("location_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => locationSessions.id, { onDelete: "cascade" }),
  updateKey: varchar("update_key", { length: 64 }).notNull(),
  locationCiphertext: text("location_ciphertext").notNull(),
  locationIv: varchar("location_iv", { length: 32 }).notNull(),
  locationAuthTag: varchar("location_auth_tag", { length: 32 }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("location_points_session_update_unique").on(table.sessionId, table.updateKey),
  index("location_points_latest_idx").on(table.sessionId, table.recordedAt),
  index("location_points_expiry_idx").on(table.expiresAt),
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
  sessionId: uuid("session_id").references(() => locationSessions.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("audit_logs_created_idx").on(table.createdAt), index("audit_logs_actor_idx").on(table.actorId)]);

export const abuseReports = pgTable("abuse_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  reporterId: uuid("reporter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  category: varchar("category", { length: 48 }).notNull(),
  details: varchar("details", { length: 2000 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [index("abuse_reports_status_idx").on(table.status)]);

export const allTables = { users, sessions, devices, devicePairings, invitations, locationSessions, permissions, locationPoints, auditLogs, abuseReports };

