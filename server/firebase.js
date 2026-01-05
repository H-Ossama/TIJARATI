// Firebase Functions entrypoint for the Tijarati API.
// Deploys the same Express app used for local development.

const { onRequest } = require('firebase-functions/v2/https');
const { createApp } = require('./app');

const app = createApp();

// Note: for secrets, set GEMINI_API_KEY in Firebase and it will be available as process.env.GEMINI_API_KEY.
// Recommended: use Firebase Functions Secrets in production.
exports.api = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  app
);
