import { createHash } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { query } from "../config/db";
import { AISettingsRow, Business } from "../services/business";
import { getWebsiteChatReply, WebsiteChatMessage } from "../services/gemini";

const router = Router();

interface WidgetContext {
  business: Business;
  settings: AISettingsRow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function widgetAccess(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (!origin) {
    return res.status(403).json({ error: "This website is not allowed to use the chat widget." });
  }
  const result = await query(
    `SELECT b.id, b.name, b.timezone, b.business_hours,
            a.greeting, a.voice_id, a.services, a.faq, a.booking_rules, s.status AS subscription_status
     FROM businesses b
     JOIN ai_settings a ON a.business_id = b.id
     JOIN subscriptions s ON s.business_id = b.id
     WHERE b.id = $1`,
    [req.params.businessId],
  );
  const row = result.rows[0];
  const settings: AISettingsRow | null = row
    ? {
        greeting: row.greeting,
        voice_id: row.voice_id,
        services: row.services ?? [],
        faq: row.faq ?? [],
        booking_rules: row.booking_rules ?? {},
      }
    : null;
  if (
    !row ||
    !["active", "trialing"].includes(row.subscription_status) ||
    !settings?.booking_rules.websiteDomains?.includes(origin)
  ) {
    return res.status(403).json({ error: "This website is not allowed to use the chat widget." });
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  res.locals.widgetContext = {
    business: row as Business,
    settings,
  } satisfies WidgetContext;
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

router.use("/:businessId", widgetAccess);

let requestsSinceCleanup = 0;
router.use("/:businessId", async (req, res, next) => {
  if (req.method === "OPTIONS") return next();
  const context = res.locals.widgetContext as WidgetContext;
  const ipHash = createHash("sha256")
    .update(`${context.business.id}:${req.ip || req.socket.remoteAddress || "unknown"}`)
    .digest("hex");
  const result = await query(
    `INSERT INTO widget_rate_limits (business_id, ip_hash, window_start, request_count)
     VALUES ($1, $2, date_trunc('minute', now()), 1)
     ON CONFLICT (business_id, ip_hash, window_start)
     DO UPDATE SET request_count = widget_rate_limits.request_count + 1
     RETURNING request_count`,
    [context.business.id, ipHash],
  );
  requestsSinceCleanup += 1;
  if (requestsSinceCleanup >= 100) {
    requestsSinceCleanup = 0;
    await query("DELETE FROM widget_rate_limits WHERE window_start < now() - interval '2 hours'");
  }
  if (Number(result.rows[0].request_count) > 30) {
    return res.status(429).json({ error: "Too many requests. Please try again in a minute." });
  }
  next();
});

router.options("/:businessId/chat", (_req, res) => res.sendStatus(204));

router.post("/:businessId/chat", async (req, res) => {
  const { business, settings } = res.locals.widgetContext as WidgetContext;
  if (!isRecord(req.body) || !Array.isArray(req.body.messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }
  const messages = req.body.messages as unknown[];
  if (messages.length === 0 || messages.length > 12) {
    return res.status(400).json({ error: "Send between 1 and 12 chat messages." });
  }
  const validated: WebsiteChatMessage[] = [];
  for (const message of messages) {
    if (
      !isRecord(message) ||
      !["user", "assistant"].includes(String(message.role)) ||
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.length > 1200
    ) {
      return res.status(400).json({ error: "Each chat message must have a valid role and text." });
    }
    validated.push({
      role: message.role as WebsiteChatMessage["role"],
      text: message.text.trim(),
    });
  }
  if (validated[validated.length - 1].role !== "user") {
    return res.status(400).json({ error: "The latest chat message must be from the visitor." });
  }

  const reply = await getWebsiteChatReply(business, settings, validated);
  res.json({ reply });
});

export default router;
