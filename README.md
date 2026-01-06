# Tijarati

Tijarati is a small bookkeeping app (sales, purchases, debts/credit book, reminders, partners profit split) with a modern Web UI that is packaged inside a React Native (Expo) shell via `WebView`.

## Repo layout

- `index.html` — **canonical Web UI** (used by mobile bundle and by the Node web server).
- `bundler.js` — bundles `index.html` into the mobile asset.
- `mobile/` — Expo React Native wrapper app (SQLite persistence, notifications, file/share bridge).
- `public/` — (removed) legacy web UI.
- `server/` — Node.js server (serves the canonical UI at `/`).
- `backend/` — older server prototype (not used by the canonical UI).

## Development

### 1) Build the mobile Web UI bundle

The mobile app loads a generated bundle at `mobile/assets/frontend_bundle.js`.

From repo root:

```bash
node bundler.js
```

### 1b) Run the web server (canonical UI)

```bash
cd server
npm install
node server.js
```

If the AI status shows "AI endpoint missing", you are likely running the legacy server in `backend/`. Use the `server/` command above (it serves `/api/ai/status` and `/api/ai`).

### 2) Run the mobile app (Expo)

```bash
cd mobile
npm install
npx expo start
```

## AI in Mobile builds (no local server)

The mobile app bundles the UI inside a WebView (`file://`). To use real AI (Gemini) **without running a local server**, you must provide a hosted backend URL.

- Deploy the Node server in `server/` to a public URL (Render/Fly/Cloud Run/etc).
- Set `TIJARATI_AI_SERVER_URL` for EAS builds (Preview + Production) to that URL.

Example:

- `TIJARATI_AI_SERVER_URL=https://your-tijarati-server.example.com`

The app will automatically call:

- `${TIJARATI_AI_SERVER_URL}/api/ai/status`
- `${TIJARATI_AI_SERVER_URL}/api/ai`

If the URL is not set or is unreachable, the app falls back to the built-in local assistant.

### Option B: No backend (direct Gemini from the app)

The app can call Gemini directly from the native layer (no server, no CORS issues). This works in EAS builds.

Important security note: shipping an API key inside a client app is **not secure** (it can be extracted). If you need a “perfect” production setup, prefer the backend approach.

To enable direct Gemini:

- Set `TIJARATI_GEMINI_API_KEY` (and optionally `TIJARATI_GEMINI_MODEL`, default `gemini-2.5-flash`) in EAS build env.

When `TIJARATI_AI_SERVER_URL` is not set, the app will:

- Use native Gemini if the key is configured
- Otherwise fall back to the built-in local assistant

## Deploy the server with Firebase (Hosting + Functions)

Yes — you can deploy the API using Firebase.

This repo is set up so Firebase Functions uses the code in `server/` (see `firebase.json`). Hosting rewrites `/api/*` to the `api` function.

### Steps

1) Install Firebase CLI and login:

```bash
npm i -g firebase-tools
firebase login
```

2) In the repo root, initialize Firebase (choose **Hosting** + **Functions**). When asked for Functions source, use the existing config (it is already set in `firebase.json`).

3) Set your Gemini key securely (recommended):

```bash
firebase functions:secrets:set GEMINI_API_KEY
```

4) Deploy:

```bash
firebase deploy
```

Or use the Windows script (recommended):

- `powershell -ExecutionPolicy Bypass -File .\deploy_firebase.ps1 -SetGeminiKey`

Or double-click / run the batch wrapper:

- `deploy_firebase.bat -SetGeminiKey`

Note: Deploying Firebase Functions typically requires upgrading the Firebase project to the **Blaze** plan (billing enabled). If you only want to deploy Hosting (no API), run:

- `powershell -ExecutionPolicy Bypass -File .\deploy_firebase.ps1 -HostingOnly`

### Project + region (this repo)

- Firebase project: `tijarati-ec23b` (see `.firebaserc`)
- Functions region: `europe-west1`

### Use it in EAS builds

Set the mobile env var to your Hosting URL:

- `TIJARATI_AI_SERVER_URL=https://tijarati-ec23b.web.app`

The app will call:

- `https://<your-project>.web.app/api/ai/status`
- `https://<your-project>.web.app/api/ai`

Notes:

- Debt reminders and “Download/Share” are handled through the native bridge in `mobile/App.js`.
- SQLite database file is stored on-device (`tijarati.db`).

## Firebase / Cloud backup

The canonical UI (`index.html`) includes Firebase Auth + Storage for cloud backup/restore.

### Web config (required)

For Firebase Auth/Storage to work reliably, create a **Web App** in Firebase Console and copy the config snippet.

- Update the `FIREBASE_CONFIG` object inside `index.html` with the exact values Firebase gives you (especially `apiKey`, `authDomain`, and `appId`).

### Android config (package name must match)

Firebase Android builds require the package name in `mobile/android/app/build.gradle` to match the one inside `mobile/android/app/google-services.json`.

Right now the Android app is configured as `com.tijarati`, but the downloaded `google-services.json` targets `com.H_Oussama.tijarati`.

Fix options:

- Recommended: in Firebase Console, create/add an Android app with package **`com.tijarati`**, then download a new `google-services.json` and replace `mobile/android/app/google-services.json`.
- Alternative: change the Android app package (Expo `mobile/app.json` + native Android sources) to match `com.H_Oussama.tijarati`.

## Scripts

- `start_app.bat` — helper script to start (Windows).

## Languages

UI supports Darija, Arabic, French, and English. Translations live in `index.html` (the `translations` object).

## GitHub hygiene

This repo includes a root `.gitignore` to avoid committing build outputs (`**/build/`), `node_modules/`, and local env files.
