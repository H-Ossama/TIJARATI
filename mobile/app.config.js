module.exports = ({ config }) => {
  // `config` already includes the contents of app.json; extend it here so EAS builds
  // can inject environment-specific values.
  const expo = config || {};

  const aiServerUrl = String(process.env.TIJARATI_AI_SERVER_URL || '').trim();
  const geminiApiKey = String(process.env.TIJARATI_GEMINI_API_KEY || '').trim();
  const geminiModel = String(process.env.TIJARATI_GEMINI_MODEL || 'gemini-2.5-flash').trim();

  return {
    ...expo,
    extra: {
      ...(expo.extra || {}),
      // Used by the bundled Web UI (index.html) via injection in mobile/App.js.
      // Example: https://your-tijarati-server.onrender.com
      aiServerUrl: aiServerUrl || (expo.extra && expo.extra.aiServerUrl) || '',

      // Optional: allow the native app to call Gemini directly (no backend).
      // WARNING: embedding API keys in a client app is not secure.
      geminiApiKey: geminiApiKey || (expo.extra && expo.extra.geminiApiKey) || '',
      geminiModel: geminiModel || (expo.extra && expo.extra.geminiModel) || 'gemini-2.5-flash',
    },
  };
};
