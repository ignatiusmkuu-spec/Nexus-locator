import type { NextFunction, Request, Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.session.userId) return next(new HttpError(401, "Sign in to continue."));
  try {
    const result = await pool.query("SELECT role, disabled_at FROM users WHERE id = $1", [req.session.userId]);
    if (!result.rows[0] || result.rows[0].disabled_at) return next(new HttpError(401, "Your session has expired. Sign in again."));
    req.session.userRole = result.rows[0].role;
  } catch (error) {
    next(error);
    return;
  }
  next();
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  await requireAuth(req, _res, (error) => {
    if (error) return next(error);
    if (req.session.userRole !== "admin") return next(new HttpError(403, "Administrator access is required."));
    next();
  });
}

export function issueCsrfToken(req: Request): string {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("base64url");
  return req.session.csrfToken;
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return next();
  const expected = req.session.csrfToken;
  const received = req.get("x-csrf-token");
  if (!expected || !received || expected.length !== received.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return next(new HttpError(403, "This request could not be verified. Refresh the page and try again."));
  }
  next();
}

export function createRateLimitKey(value: string) {
  return value.trim().toLowerCase();
}

