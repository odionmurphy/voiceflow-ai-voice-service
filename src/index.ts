import express from 'express';
import dotenv from 'dotenv';
import voiceRoutes from './routes/voice';
import { startFollowupScheduler } from './jobs/followups';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

// Twilio webhooks send application/x-www-form-urlencoded bodies, not JSON.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'voiceflow-ai-voice-service' })
);

app.use('/voice', voiceRoutes);

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log(`VoiceFlow AI voice-service listening on http://localhost:${PORT}`);
  console.log(`Twilio webhook URLs to configure on your phone number:`);
  console.log(`  Voice webhook (A call comes in): ${process.env.PUBLIC_BASE_URL || 'http://localhost:' + PORT}/voice/incoming`);
  console.log(`  Status callback: ${process.env.PUBLIC_BASE_URL || 'http://localhost:' + PORT}/voice/status`);
  startFollowupScheduler();
});

export default app;
