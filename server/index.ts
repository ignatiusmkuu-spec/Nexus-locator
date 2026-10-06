import express from "express";
import session from "express-session";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Server } from "socket.io";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { PostgresSessionStore } from "./session-store.js";
import { HttpError } from "./security.js";
import { createAuthRouter } from "./routes/auth.js";
import deviceRouter from "./routes/devices.js";
import { createLocationRouter } from "./routes/location.js";
import { createAdminRouter } from "./routes/admin.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const port = Number(process.env.PORT ?? 5000);
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) {
  throw new Error("SESSION_SECRET must be configured as a secret of at least 32 characters.");
}
const retentionHours = Number(process.env.LOCATION_RETENTION_HOURS ?? 24);
if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 720) {
  throw new Error("LOCATION_RETENTION_HOURS must be a whole number between 1 and 720.");
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  serveClient: false,
  maxHttpBufferSize: 32_000,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
    },
  },
}));
app.use(express.json({ limit: "32kb", strict: true }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

const sessionMiddleware = session({
  name: "nexus.sid",
  secret,
  store: new PostgresSessionStore(pool),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
io.engine.use((req, res, next) => {
  const origin = req.headers.origin;
  const expectedHost = req.headers["x-forwarded-host"]?.toString().split(",")[0].trim() ?? req.headers.host;
  if (origin && expectedHost) {
    try {
      if (new URL(origin).host !== expectedHost) {
        res.writeHead(403);
        res.end("Origin not allowed");
        return;
      }
    } catch {
      res.writeHead(403);
      res.end("Invalid origin");
      return;
    }
  }
  next();
});
io.use(async (socket, next) => {
  const userId = socket.request.session?.userId;
  if (!userId) return next(new Error("Authentication required."));
  try {
    const result = await pool.query("SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL", [userId]);
    if (!result.rows[0]) return next(new Error("Authentication required."));
    next();
  } catch (error) {
    next(error instanceof Error ? error : new Error("Authentication unavailable."));
  }
});
io.on("connection", (socket) => {
  const userId = socket.request.session.userId!;
  socket.join(`user:${userId}`);
  const timer = setInterval(async () => {
    try {
      const result = await pool.query(
        `SELECT 1 FROM sessions ss JOIN users u ON u.id=ss.user_id
         WHERE ss.sid=$1 AND ss.user_id=$2 AND ss.expire > NOW() AND u.disabled_at IS NULL`,
        [socket.request.sessionID, userId],
      );
      if (!result.rows[0]) socket.disconnect(true);
    } catch {
      socket.disconnect(true);
    }
  }, 60_000);
  socket.on("disconnect", () => clearInterval(timer));
});

const apiMetrics = new Map<string, number>();
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.once("finish", () => {
    if (!req.path.startsWith("/api/")) return;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path.replace(/[a-f0-9-]{32,}/gi, ":token");
    const key = `${req.method} ${route}`;
    apiMetrics.set(key, (apiMetrics.get(key) ?? 0) + (Date.now() - startedAt >= 0 ? 1 : 0));
  });
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in a few minutes." },
});
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Invitation limit reached. Try again later." },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/invitations", inviteLimiter);
app.use("/api/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});
app.use("/api/auth", createAuthRouter(io));
app.use("/api/devices", deviceRouter);
app.use("/api", createLocationRouter(io, retentionHours));
app.use("/api/admin", createAdminRouter(io, apiMetrics));

if (process.env.NODE_ENV === "production") {
  const publicDir = path.resolve(dirname, "../dist/public");
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io")) return next();
    res.sendFile(path.join(publicDir, "index.html"), (error) => error && next(error));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: path.resolve(dirname, "../vite.config.ts"),
    server: { middlewareMode: true, allowedHosts: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
  next();
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : "Something went wrong. Please try again.";
  if (status >= 500) console.error("Request failed:", error instanceof Error ? error.message : "Unknown error");
  res.status(status).json({ error: message });
});

async function cleanupExpiredData() {
  try {
    await pool.query("DELETE FROM location_points WHERE expires_at < NOW()");
    await pool.query("DELETE FROM sessions WHERE expire < NOW()");
    await pool.query("DELETE FROM device_pairings WHERE expires_at < NOW() - INTERVAL '1 day' OR used_at IS NOT NULL");
    await pool.query("DELETE FROM invitations WHERE expires_at < NOW() - INTERVAL '7 days'");
  } catch (error) {
    console.error("Scheduled privacy cleanup failed:", error instanceof Error ? error.message : "Unknown error");
  }
}

try {
  await pool.query("SELECT 1");
  await cleanupExpiredData();
  setInterval(() => void cleanupExpiredData(), 15 * 60 * 1000).unref();
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Nexus Locator listening on port ${port}; precise location retention is ${retentionHours} hours.`);
  });
} catch (error) {
  console.error("Unable to start Nexus Locator. Check the database connection and schema:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
}

process.on("SIGTERM", () => {
  io.close();
  httpServer.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
});

