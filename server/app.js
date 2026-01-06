const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

// Node 18+ provides global fetch; older Node versions need a polyfill.
const fetch = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import('node-fetch').then(m => m.default(...args));

// Local dev: load env from server/.env, then fallback to repo-root .env.
// In Firebase Functions, environment variables / secrets are injected by the platform.
try {
  require('dotenv').config({ path: path.resolve(__dirname, '.env') });
  if (!process.env.GEMINI_API_KEY) {
    const rootEnv = path.resolve(__dirname, '..', '.env');
    if (fs.existsSync(rootEnv)) require('dotenv').config({ path: rootEnv });
  }
} catch { }

const db = require('./json-db');

function toLatinDigits(input) {
  const s = String(input ?? '');
  // Arabic-Indic: \u0660-\u0669 (٠١٢٣٤٥٦٧٨٩)
  // Eastern Arabic-Indic: \u06F0-\u06F9 (۰۱۲۳۴۵۶۷۸۹)
  return s
    .replace(/[\u0660-\u0669]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\u06F0-\u06F9]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function createApp() {
  const app = express();

  app.use(cors());
  app.use(bodyParser.json());

  // Canonical UI: repo-root `index.html` (same file used for the mobile bundle).
  // For Firebase Hosting, you typically serve static assets via Hosting, not Functions.
  const REPO_ROOT = path.resolve(__dirname, '..');

  app.get('/', (req, res) => {
    res.sendFile(path.join(REPO_ROOT, 'index.html'));
  });

  app.get('/legacy', (req, res) => res.redirect('/'));

  // ================= API ROUTES =================

  app.get('/api/status', (req, res) => {
    res.json({ status: 'online', time: new Date().toISOString() });
  });

  // --- AI (Gemini) ---
  app.get('/api/ai/status', (req, res) => {
    const enabled = !!process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    res.json({
      enabled,
      model,
      reason: enabled ? 'ok' : 'missing_api_key',
      hint: enabled
        ? undefined
        : 'Set GEMINI_API_KEY in server/.env (or repo-root .env) and restart the server.'
    });
  });

  app.post('/api/ai', async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(400).json({ error: 'GEMINI_API_KEY is not configured' });
      }

      const message = (req.body?.message || '').toString().trim();
      const lang = (req.body?.lang || 'english').toString();
      if (!message) return res.status(400).json({ error: 'Missing message' });

      // Summary can come from the client (mobile/web offline bundle) so AI uses on-device data.
      // If not provided, fall back to server-side stored transactions.
      const providedSummary = req.body?.summary && typeof req.body.summary === 'object' ? req.body.summary : null;

      const summary = (() => {
        if (providedSummary) return providedSummary;

        const txs = db.getTransactions() || [];
        const totalSales = txs.filter(t => t.type === 'sale').reduce((s, t) => s + (t.amount || 0), 0);
        const totalPurchases = txs.filter(t => t.type === 'purchase').reduce((s, t) => s + (t.amount || 0), 0);
        const netProfit = totalSales - totalPurchases;
        const pendingDebts = txs.filter(t => t.isCredit && !t.isFullyPaid)
          .reduce((s, t) => s + ((t.amount || 0) - (t.paidAmount || 0)), 0);

        const topItems = (() => {
          const counts = new Map();
          txs.filter(t => t.type === 'sale').forEach(t => {
            const name = (t.item || '').toString().trim();
            if (!name) return;
            const key = name.toLowerCase();
            counts.set(key, (counts.get(key) || 0) + (t.quantity || 1));
          });
          return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([k, v]) => ({ item: k, qty: v }));
        })();

        return {
          totalSales,
          totalPurchases,
          netProfit,
          pendingDebts,
          topSaleItems: topItems
        };
      })();

      const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

      const langMap = {
        darija: 'Moroccan Darija (Arabic script when possible)',
        arabic: 'Arabic',
        french: 'French',
        english: 'English'
      };

      const system = `You are Tijarati's assistant — friendly, practical, and proactive.

    You receive:
    1) DATA SUMMARY (JSON) from the user's bookkeeping app
    2) USER QUESTION

    Guidelines:
    - Be helpful. Use the data summary when relevant, but you may also answer general questions.
    - If information is missing, ask 1-3 precise follow-up questions.
    - For business/investing questions, provide balanced advice, trade-offs, and 3-6 concrete next steps.
    - Investment guidance must be general education (not professional financial advice). Do not guarantee outcomes.
    - Keep it concise but not overly short (up to ~10 short sentences or 4-8 bullets).
    - Use the user's language: ${langMap[lang] || 'English'}.
    - IMPORTANT: Use Western/Latin digits (0-9) for ALL numbers.`;

      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${system}\n\nDATA SUMMARY (JSON): ${JSON.stringify(summary)}\n\nUSER QUESTION: ${message}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 512
        }
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        const txt = await resp.text();
        return res.status(500).json({ error: 'Gemini request failed', details: txt });
      }

      const data = await resp.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!reply) return res.status(500).json({ error: 'No reply from model' });

      res.json({ reply: toLatinDigits(reply) });
    } catch (error) {
      console.error('AI Error:', error);
      res.status(500).json({ error: error.message || 'AI error' });
    }
  });

  // --- TRANSACTIONS ---
  app.get('/api/transactions', (req, res) => {
    try {
      const transactions = db.getTransactions();
      transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json(transactions);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/transactions', (req, res) => {
    try {
      const tx = req.body;
      if (!tx.id || !tx.item || !tx.amount) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      db.addTransaction(tx);
      res.json({ success: true, id: tx.id });
    } catch (error) {
      console.error('Insert Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // --- PARTNERS ---
  app.get('/api/partners', (req, res) => {
    try {
      const partners = db.getPartners();
      res.json(partners);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/partners', (req, res) => {
    try {
      const { name, percent } = req.body;
      const id = db.addPartner({ name, percent, createdAt: Date.now() });
      res.json({ success: true, id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/partners/:id', (req, res) => {
    try {
      db.deletePartner(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return app;
}

module.exports = { createApp };
