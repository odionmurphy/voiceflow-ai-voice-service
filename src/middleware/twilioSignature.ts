import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4001';

// Twilio signs each webhook request against the exact URL it was configured to call
// (PUBLIC_BASE_URL + path). We reconstruct that same URL here rather than trusting
// req.protocol/req.headers.host, since this app doesn't set Express's `trust proxy` -
// behind Render's TLS-terminating proxy req.protocol reports "http", which would make
// every legitimate Twilio request fail validation too, not just forged ones.
export function requireTwilioSignature(req: Request, res: Response, next: NextFunction) {
  if (process.env.VALIDATE_TWILIO_SIGNATURE !== 'true') return next();

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[twilio-signature] VALIDATE_TWILIO_SIGNATURE=true but TWILIO_AUTH_TOKEN is not set - rejecting all requests');
    return res.status(403).send('Twilio Request Validation Failed.');
  }

  const url = `${PUBLIC_BASE_URL}${req.originalUrl}`;
  if (!twilio.validateExpressRequest(req, authToken, { url })) {
    return res.status(403).send('Twilio Request Validation Failed.');
  }

  next();
}
