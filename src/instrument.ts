import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';

// Loaded here (not in index.ts) so SENTRY_DSN is available from .env in local dev
// before Sentry.init() runs - in production (Render) env vars are already set by the
// platform, so this is a no-op there.
dotenv.config();

// Must be imported before anything else in index.ts - Sentry's auto-instrumentation
// patches modules (http, pg, express) as they're required, so this has to run first.
if (process.env.SENTRY_DSN) {
  // eslint-disable-next-line no-console
  console.log('[sentry] initializing with DSN:', process.env.SENTRY_DSN);
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    // TEMPORARY - prints the SDK's internal send attempts/failures to diagnose why
    // events aren't arriving. Remove once resolved.
    debug: true,
  });
} else {
  // eslint-disable-next-line no-console
  console.warn('[sentry] SENTRY_DSN not set - error monitoring is disabled.');
}
