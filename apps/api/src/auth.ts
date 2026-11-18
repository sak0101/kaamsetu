import type { RequestHandler, Response } from "express";
import { ApiError } from "./errors";
import type { AuthContext, Deps, Role } from "./types";

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;
const MAX_TOKEN_LENGTH = 4096;

/** The verified request context. Throws if authenticate() did not run (a programming error). */
export function getAuth(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) throw new ApiError(401, "missing_token", "Authentication required.");
  return auth;
}

/**
 * Authenticates every request:
 *   1. Bearer token required.
 *   2. The token is verified by Supabase Auth (auth.getUser(jwt)). Nothing is decoded locally.
 *   3. The acting user id is user.id from that verified result. No header, query
 *      parameter or body field can influence it.
 *   4. The user's own profile (read under their JWT / RLS) supplies the role.
 *
 * Suspension: clients cannot read is_suspended (column grants), so it is enforced
 * authoritatively inside every database mutation function and surfaces here as
 * 403 account_suspended.
 */
export function authenticate(deps: Deps): RequestHandler {
  return async (req, res, next) => {
    const match = BEARER.exec(req.headers.authorization ?? "");
    if (!match || match[1]!.length > MAX_TOKEN_LENGTH) {
      throw new ApiError(401, "missing_token", "Authentication required.");
    }
    const jwt = match[1]!;

    const user = await deps.verifyJwt(jwt);
    if (!user) {
      throw new ApiError(401, "invalid_token", "Your session is invalid or has expired. Please sign in again.");
    }

    const reads = deps.readsFor(jwt);
    const profile = await reads.profile(user.id);
    if (!profile || profile.id !== user.id) {
      throw new ApiError(403, "profile_missing", "No KaamSetu profile exists for this account.");
    }

    res.locals.auth = { userId: user.id, jwt, role: profile.role, profile, reads } satisfies AuthContext;
    next();
  };
}

/** Fail fast on the wrong account type. The database re-checks the role on every mutation. */
export function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (getAuth(res).role !== role) {
      throw new ApiError(403, "wrong_role", `This action is for ${role} accounts only.`);
    }
    next();
  };
}
