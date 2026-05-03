import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { agentsRouter } from './routes/agents.js';
import { offersRouter } from './routes/offers.js';
import { dealsRouter } from './routes/deals.js';
import { internalRouter } from './routes/internal.js';
import { listingsRouter } from './routes/listings.js';
import { negotiationsRouter } from './routes/negotiations.js';
import { messagesRouter } from './routes/messages.js';
import { initDB } from './store.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Health ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: '1.0.0' });
});

// ── Routes ──────────────────────────────────────────────────────────
app.use('/api/agents', agentsRouter);
app.use('/api/offers', offersRouter);
app.use('/api/deals', dealsRouter);
app.use('/api/listings', listingsRouter);
app.use('/api/negotiations', negotiationsRouter);
app.use('/api/messages', messagesRouter);
app.use('/internal', internalRouter);

// ── 404 ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup: connect DB, then listen ─────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Phantom Protocol Coordinator running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('[FATAL] Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
