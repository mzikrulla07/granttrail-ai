/**
 * Authentication + role-based authorization.
 *
 * ┌──────────────── PRODUCTION (AUTH_MODE=cognito) ──────────────────────────┐
 * │ 1. The React app signs users in with the Amazon Cognito Hosted UI        │
 * │    (OAuth 2.0 authorization-code + PKCE; e.g. via aws-amplify/auth).     │
 * │ 2. The browser sends the Cognito ACCESS token on every API call:         │
 * │       Authorization: Bearer <jwt>                                        │
 * │ 3. `cognitoAuthenticator` below verifies signature (JWKS), issuer,       │
 * │    audience/client_id, token_use and expiry with aws-jwt-verify.         │
 * │ 4. The token `sub` is mapped to users.cognito_sub; the application role │
 * │    comes from our users table (or from Cognito groups, if preferred).    │
 * │ Passwords, MFA, lockout and password policy all live in Cognito — this   │
 * │ database never stores credentials.                                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * DEVELOPMENT (AUTH_MODE=dev): the UI's "Signed in as" switcher sends
 * `X-Demo-User: <email>` and the server looks the user up among seeded
 * accounts. This mode is refused at startup when NODE_ENV=production.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { AppConfig } from '../config.js';
import type { Queryable } from '../db/index.js';
import { AppError } from '../http/errors.js';

export type Role = 'grants_specialist' | 'finance_director' | 'partner_agency' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

export const ROLE_LABELS: Record<Role, string> = {
  grants_specialist: 'Grants Specialist',
  finance_director: 'Finance Director',
  partner_agency: 'Partner Agency',
  admin: 'Administrator',
};

export type Permission =
  | 'subaward:read'
  | 'subaward:upload'
  | 'subaward:edit'
  | 'subaward:approve'
  | 'subaward:export'
  | 'subaward:report'
  | 'audit:read';

/**
 * Role → permission matrix. Partner agencies have no access in the MVP; a future
 * release will grant them a scoped "partner:update-own-organisation" permission.
 */
export const PERMISSIONS: Record<Permission, Role[]> = {
  'subaward:read': ['grants_specialist', 'finance_director', 'admin'],
  'subaward:upload': ['grants_specialist', 'admin'],
  'subaward:edit': ['grants_specialist', 'admin'],
  'subaward:approve': ['grants_specialist', 'admin'],
  'subaward:export': ['grants_specialist', 'finance_director', 'admin'],
  'subaward:report': ['grants_specialist', 'admin'],
  'audit:read': ['grants_specialist', 'finance_director', 'admin'],
};

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission].includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

export const DEFAULT_DEV_USER_EMAIL = 'dana.whitfield@riverbend.example';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
}

const toUser = (r: UserRow): AuthUser => ({ id: r.id, email: r.email, fullName: r.full_name, role: r.role });

export function currentUser(res: Response): AuthUser {
  const u = res.locals.user as AuthUser | undefined;
  if (!u) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return u;
}

function devAuthenticator(db: Queryable): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('x-demo-user');
      // CSRF guard: a hostile web page can send a "simple" cross-site POST (e.g. a
      // multipart form) without a preflight, but it cannot add custom headers.
      // So every state-changing request must carry X-Demo-User or X-Requested-With.
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (unsafe && !header && req.header('x-requested-with') !== 'GrantTrail') {
        throw new AppError(403, 'CSRF_CHECK_FAILED', 'This request is missing the required application header.');
      }
      const email = (header ?? DEFAULT_DEV_USER_EMAIL).trim().toLowerCase();
      if (email.length > 254) throw new AppError(401, 'UNAUTHENTICATED', 'Unknown demo user.');
      const { rows } = await db.query<UserRow>(
        'SELECT id, email, full_name, role FROM users WHERE lower(email) = $1 AND is_active = true',
        [email],
      );
      if (!rows[0]) throw new AppError(401, 'UNAUTHENTICATED', 'Unknown demo user.');
      res.locals.user = toUser(rows[0]);
      next();
    } catch (err) {
      next(err);
    }
  };
}

function cognitoAuthenticator(db: Queryable, config: AppConfig): RequestHandler {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.auth.cognitoUserPoolId!,
    clientId: config.auth.cognitoClientId!,
    tokenUse: 'access',
  });
  return async (req, res, next) => {
    try {
      const auth = req.header('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      let sub: string;
      try {
        const payload = await verifier.verify(token);
        sub = payload.sub;
      } catch {
        throw new AppError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
      }
      const { rows } = await db.query<UserRow>(
        'SELECT id, email, full_name, role FROM users WHERE cognito_sub = $1 AND is_active = true',
        [sub],
      );
      if (!rows[0]) throw new AppError(403, 'NOT_PROVISIONED', 'Your account has not been granted access to GrantTrail.');
      res.locals.user = toUser(rows[0]);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function authenticate(db: Queryable, config: AppConfig): RequestHandler {
  return config.auth.mode === 'cognito' ? cognitoAuthenticator(db, config) : devAuthenticator(db);
}

export function requirePermission(permission: Permission): RequestHandler {
  return (_req, res, next) => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    if (!can(user.role, permission)) {
      return next(
        new AppError(403, 'FORBIDDEN', `Your role (${ROLE_LABELS[user.role]}) does not have permission to perform this action.`),
      );
    }
    next();
  };
}
