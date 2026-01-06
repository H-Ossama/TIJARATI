import { useColorScheme } from 'react-native';

import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, Platform, BackHandler, Linking, TextInput, Pressable, AppState } from 'react-native';
import { WebView } from 'react-native-webview';
import * as SQLite from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { getApp } from '@react-native-firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from '@react-native-firebase/auth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { htmlContent } from './assets/frontend_bundle';
import googleServices from './google-services.json';

// NOTE: Use async SQLite APIs to avoid sync/JSI crashes (e.g. when Remote JS Debugging is enabled).
let dbPromise = null;

async function initDb() {
  const db = await SQLite.openDatabaseAsync('tijarati.db');

  // Use runAsync per statement (more reliable than execAsync on some Android builds).
  await db.runAsync(
    'CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, type TEXT, item TEXT, amount REAL, quantity REAL, date TEXT, isCredit INTEGER, clientName TEXT, paidAmount REAL, isFullyPaid INTEGER, currency TEXT, createdAt INTEGER, isMock INTEGER DEFAULT 0)'
  );
  await db.runAsync(
    'CREATE TABLE IF NOT EXISTS partners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, percent REAL, createdAt INTEGER, isMock INTEGER DEFAULT 0)'
  );

  // Add missing columns for newer UI versions (safe on existing installs)
  try {
    const txCols = await db.getAllAsync('PRAGMA table_info(transactions)');
    const hasCol = (name) => Array.isArray(txCols) && txCols.some((c) => c && c.name === name);
    if (!hasCol('unitPrice')) await db.runAsync('ALTER TABLE transactions ADD COLUMN unitPrice REAL');
    if (!hasCol('pricingMode')) await db.runAsync('ALTER TABLE transactions ADD COLUMN pricingMode TEXT');
    if (!hasCol('isInstallmentPlan')) await db.runAsync('ALTER TABLE transactions ADD COLUMN isInstallmentPlan INTEGER DEFAULT 0');
    if (!hasCol('installments')) await db.runAsync('ALTER TABLE transactions ADD COLUMN installments TEXT');
    if (!hasCol('dueDate')) await db.runAsync('ALTER TABLE transactions ADD COLUMN dueDate TEXT');
    if (!hasCol('reminderId')) await db.runAsync('ALTER TABLE transactions ADD COLUMN reminderId TEXT');
    if (!hasCol('isMock')) await db.runAsync('ALTER TABLE transactions ADD COLUMN isMock INTEGER DEFAULT 0');
  } catch { }

  try {
    const partnerCols = await db.getAllAsync('PRAGMA table_info(partners)');
    const hasPartnerCol = (name) => Array.isArray(partnerCols) && partnerCols.some((c) => c && c.name === name);
    if (!hasPartnerCol('isMock')) await db.runAsync('ALTER TABLE partners ADD COLUMN isMock INTEGER DEFAULT 0');
    if (!hasPartnerCol('investedBase')) await db.runAsync('ALTER TABLE partners ADD COLUMN investedBase REAL');
    if (!hasPartnerCol('investedAt')) await db.runAsync('ALTER TABLE partners ADD COLUMN investedAt TEXT');
    if (!hasPartnerCol('profitSchedule')) await db.runAsync('ALTER TABLE partners ADD COLUMN profitSchedule TEXT');
    if (!hasPartnerCol('notes')) await db.runAsync('ALTER TABLE partners ADD COLUMN notes TEXT');
    if (!hasPartnerCol('payouts')) await db.runAsync('ALTER TABLE partners ADD COLUMN payouts TEXT');
  } catch { }

  return db;
}

async function getDb() {
  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

function toLatinDigits(input) {
  const s = String(input ?? '');
  // Arabic-Indic: \u0660-\u0669 (٠١٢٣٤٥٦٧٨٩)
  // Eastern Arabic-Indic: \u06F0-\u06F9 (۰۱۲۳۴۵۶۷۸۹)
  return s
    .replace(/[\u0660-\u0669]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\u06F0-\u06F9]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const webViewRef = useRef(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const themeColor = isDark ? '#111827' : '#0F766E';

  const aiServerUrlRaw = (() => {
    try {
      // Expo SDK 49+ prefers expoConfig. Keep a fallback for older manifests.
      return (
        Constants?.expoConfig?.extra?.aiServerUrl
        || Constants?.manifest?.extra?.aiServerUrl
        || Constants?.manifest2?.extra?.aiServerUrl
        || ''
      );
    } catch {
      return '';
    }
  })();

  const geminiApiKeyRaw = (() => {
    try {
      return (
        Constants?.expoConfig?.extra?.geminiApiKey
        || Constants?.manifest?.extra?.geminiApiKey
        || Constants?.manifest2?.extra?.geminiApiKey
        || ''
      );
    } catch {
      return '';
    }
  })();

  const geminiModelRaw = (() => {
    try {
      return (
        Constants?.expoConfig?.extra?.geminiModel
        || Constants?.manifest?.extra?.geminiModel
        || Constants?.manifest2?.extra?.geminiModel
        || ''
      );
    } catch {
      return '';
    }
  })();

  const aiServerUrl = String(aiServerUrlRaw || '').trim();
  const geminiApiKeyConfig = String(geminiApiKeyRaw || '').trim();
  const geminiModel = (String(geminiModelRaw || '').trim() || 'gemini-2.5-flash');

  const [runtimeGeminiKey, setRuntimeGeminiKey] = useState('');

  const getEffectiveGeminiApiKey = async () => {
    const current = String(runtimeGeminiKey || geminiApiKeyConfig || '').trim();
    if (current) return current;
    try {
      const stored = await SecureStore.getItemAsync('tijarati_gemini_api_key');
      const next = String(stored || '').trim();
      if (next) {
        setRuntimeGeminiKey(next);
        return next;
      }
    } catch { }
    return '';
  };

  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync('tijarati_gemini_api_key');
        if (stored) setRuntimeGeminiKey(String(stored).trim());
      } catch { }
    })();
  }, []);

  const effectiveGeminiApiKey = String(runtimeGeminiKey || geminiApiKeyConfig || '').trim();

  const htmlSource = { html: htmlContent, baseUrl: 'file:///android_asset/' };

  // ==========================
  // App Lock (PIN + Fingerprint)
  // ==========================
  const [locked, setLocked] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [lockError, setLockError] = useState('');
  const [pinEnabled, setPinEnabled] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);

  const hashPin = async (pin) => {
    const raw = String(pin || '').trim();
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw);
  };

  const refreshSecurityStatus = async () => {
    const pinHash = await SecureStore.getItemAsync('tijarati_pin_hash');
    const bioFlag = await SecureStore.getItemAsync('tijarati_bio_enabled');

    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    const available = !!hasHardware && !!enrolled;

    setPinEnabled(!!pinHash);
    setBiometricEnabled(bioFlag === '1');
    setBiometricsAvailable(available);
    setLocked(!!pinHash);

    return { pinEnabled: !!pinHash, biometricEnabled: bioFlag === '1', biometricsAvailable: available };
  };

  const tryBiometricUnlock = async () => {
    try {
      if (!pinEnabled) return false;
      if (!biometricEnabled) return false;
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !enrolled) return false;

      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Tijarati',
        cancelLabel: 'Use PIN',
        disableDeviceFallback: true
      });

      if (res && res.success) {
        setLocked(false);
        setPinInput('');
        setLockError('');
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const unlockWithPin = async () => {
    try {
      const pinHash = await SecureStore.getItemAsync('tijarati_pin_hash');
      if (!pinHash) {
        setLocked(false);
        return;
      }
      const entered = String(pinInput || '').trim();
      if (entered.length < 4) {
        setLockError('PIN must be at least 4 digits');
        return;
      }

      const enteredHash = await hashPin(entered);
      if (enteredHash === pinHash) {
        setLocked(false);
        setPinInput('');
        setLockError('');
      } else {
        setLockError('Wrong PIN');
      }
    } catch {
      setLockError('Unlock failed');
    }
  };

  useEffect(() => {
    const backAction = () => {
      if (webViewRef.current) {
        // Send a message to WebView to handle back navigation
        webViewRef.current.postMessage(JSON.stringify({ type: 'GO_BACK' }));
        return true; // Stop hardware back (exit)
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, []);

  useEffect(() => {
    refreshSecurityStatus();
  }, []);

  useEffect(() => {
    try {
      // webClientId comes from google-services.json (oauth_client client_type=3)
      const extractedWebClientId = (() => {
        try {
          const client0 = googleServices?.client?.[0];
          const oauth = Array.isArray(client0?.oauth_client) ? client0.oauth_client : [];
          const web = oauth.find((c) => c && c.client_type === 3 && typeof c.client_id === 'string');
          return String(web?.client_id || '').trim();
        } catch {
          return '';
        }
      })();

      GoogleSignin.configure({
        webClientId:
          extractedWebClientId
          || '796219379032-to20l2jbsnk2k4armola7j71b82k6met.apps.googleusercontent.com',
        offlineAccess: false,
      });
    } catch { }
  }, []);

  useEffect(() => {
    if (locked) {
      tryBiometricUnlock();
    }
  }, [locked, pinEnabled, biometricEnabled]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshSecurityStatus();
      } else if (next === 'background') {
        if (pinEnabled) setLocked(true);
      }
    });
    return () => sub.remove();
  }, [pinEnabled]);

  useEffect(() => {
    if (webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ type: 'THEME_CHANGED', payload: colorScheme }));
    }
  }, [colorScheme]);

  useEffect(() => {
    (async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (perm.status !== 'granted') {
          await Notifications.requestPermissionsAsync();
        }
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('debts', {
            name: 'Debt reminders',
            importance: Notifications.AndroidImportance.HIGH,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#14b8a6',
          });
        }
      } catch { }
    })();
  }, []);

  const handleMessage = async (event) => {
    let id = null;
    let type = null;
    let payload = null;
    let result = null;

    let firebaseAuth = null;

    const mapUser = (u) => {
      if (!u) return null;
      return {
        uid: u.uid,
        email: u.email || '',
        displayName: u.displayName || ''
      };
    };

    try {
      const data = JSON.parse(event.nativeEvent.data);
      id = data?.id;
      type = data?.type;
      payload = data?.payload;

      const app = getApp();
      firebaseAuth = getAuth(app);

      if (type === 'EXIT_APP') {
        BackHandler.exitApp();
        return;
      }

      // ==========================
      // AI (Native Gemini, no server)
      if (type === 'AI_STATUS') {
        const key = await getEffectiveGeminiApiKey();
        result = {
          success: true,
          enabled: !!key,
          model: geminiModel,
          reason: key ? 'ok' : 'missing_api_key'
        };
      } else if (type === 'AI_SET_GEMINI_KEY') {
        try {
          const key = String(payload?.key || '').trim();
          if (!key) {
            await SecureStore.deleteItemAsync('tijarati_gemini_api_key');
            setRuntimeGeminiKey('');
            result = { success: true, cleared: true };
          } else {
            await SecureStore.setItemAsync('tijarati_gemini_api_key', key);
            setRuntimeGeminiKey(key);
            result = { success: true };
          }
        } catch (err) {
          result = { success: false, error: String(err?.message || err) };
        }
      } else if (type === 'AI_CLEAR_GEMINI_KEY') {
        try {
          await SecureStore.deleteItemAsync('tijarati_gemini_api_key');
          setRuntimeGeminiKey('');
          result = { success: true };
        } catch (err) {
          result = { success: false, error: String(err?.message || err) };
        }
      } else if (type === 'AI_GEMINI') {
        const key = await getEffectiveGeminiApiKey();
        if (!key) {
          result = { success: false, error: 'missing_api_key' };
        } else {
          const message = String(payload?.message || '').trim();
          const lang = String(payload?.lang || 'english');
          const summary = (payload?.summary && typeof payload.summary === 'object') ? payload.summary : null;
          if (!message) {
            result = { success: false, error: 'Missing message' };
          } else {
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

            const safeSummary = summary || {};
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(key)}`;
            const body = {
              contents: [
                {
                  role: 'user',
                  parts: [{ text: `${system}\n\nDATA SUMMARY (JSON): ${JSON.stringify(safeSummary)}\n\nUSER QUESTION: ${message}` }]
                }
              ],
              generationConfig: { temperature: 0.5, maxOutputTokens: 512 }
            };

            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });

            if (!resp.ok) {
              const txt = await resp.text();
              result = { success: false, error: 'Gemini request failed', details: txt };
            } else {
              const data = await resp.json();
              const reply = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
              if (!reply) result = { success: false, error: 'No reply from model' };
              else result = { success: true, reply: toLatinDigits(reply) };
            }
          }
        }
      }

      // ==========================
      // Cloud (Native Firebase)
      // ==========================
      else if (type === 'CLOUD_GET_USER') {
        const u = firebaseAuth.currentUser;
        result = { success: true, user: mapUser(u) };
      } else if (type === 'CLOUD_SIGNIN') {
        try {
          await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
          const signInRes = await GoogleSignin.signIn();
          const idToken = signInRes?.idToken || signInRes?.data?.idToken;
          if (!idToken) {
            result = { success: false, error: 'Google sign-in failed (no idToken)' };
          } else {
            const credential = GoogleAuthProvider.credential(idToken);
            const userCred = await signInWithCredential(firebaseAuth, credential);
            result = { success: true, user: mapUser(userCred?.user || firebaseAuth.currentUser) };
          }
        } catch (e) {
          const msg = String(e?.message || e || 'Sign-in failed');
          if (msg.includes('DEVELOPER_ERROR')) {
            result = {
              success: false,
              error:
                'DEVELOPER_ERROR: Google Sign-In is not configured for this app signing key. '
                + 'Fix: run `cd mobile/android; ./gradlew signingReport` and add the Debug SHA1 for package `com.tijarati` '
                + 'in Firebase Console (Project settings → Your apps → Android → SHA certificate fingerprints), '
                + 'then download a fresh google-services.json and rebuild the app.'
            };
          } else {
            result = { success: false, error: msg };
          }
        }
      } else if (type === 'CLOUD_SIGNOUT') {
        try { await firebaseSignOut(firebaseAuth); } catch { }
        try { await GoogleSignin.signOut(); } catch { }
        result = { success: true };
      } else if (type === 'AUTH_EMAIL_SIGNIN') {
        try {
          const email = String(payload?.email || '').trim();
          const password = String(payload?.password || '').trim();
          if (!email || !password) {
            result = { success: false, error: 'Missing email/password' };
          } else {
            const userCred = await signInWithEmailAndPassword(firebaseAuth, email, password);
            result = { success: true, user: mapUser(userCred?.user || firebaseAuth.currentUser) };
          }
        } catch (e) {
          result = { success: false, error: String(e?.message || e || 'Sign-in failed') };
        }
      } else if (type === 'AUTH_EMAIL_SIGNUP') {
        try {
          const email = String(payload?.email || '').trim();
          const password = String(payload?.password || '').trim();
          if (!email || !password) {
            result = { success: false, error: 'Missing email/password' };
          } else {
            const userCred = await createUserWithEmailAndPassword(firebaseAuth, email, password);
            result = { success: true, user: mapUser(userCred?.user || firebaseAuth.currentUser) };
          }
        } catch (e) {
          result = { success: false, error: String(e?.message || e || 'Sign-up failed') };
        }
      } else if (type === 'AUTH_RESET_PASSWORD') {
        try {
          const email = String(payload?.email || '').trim();
          if (!email) {
            result = { success: false, error: 'Missing email' };
          } else {
            await sendPasswordResetEmail(firebaseAuth, email);
            result = { success: true };
          }
        } catch (e) {
          result = { success: false, error: String(e?.message || e || 'Reset failed') };
        }
      } else if (type === 'CLOUD_BACKUP') {
        result = { success: false, error: 'Cloud backup is disabled in this build.' };
      } else if (type === 'CLOUD_STATUS') {
        const u = firebaseAuth.currentUser;
        result = { success: true, user: mapUser(u), manifest: null };
      } else if (type === 'CLOUD_RESTORE') {
        result = { success: false, error: 'Cloud restore is disabled in this build.' };
      }

      // Security: PIN + biometrics
      if (type === 'SECURITY_GET') {
        result = await refreshSecurityStatus();
      } else if (type === 'SECURITY_SET_PIN') {
        const pin = String(payload?.pin || '').trim();
        if (pin.length < 4) {
          result = { success: false, error: 'PIN must be at least 4 digits' };
        } else {
          const pinHash = await hashPin(pin);
          await SecureStore.setItemAsync('tijarati_pin_hash', pinHash);
          setPinEnabled(true);
          setLocked(true);
          result = { success: true };
        }
      } else if (type === 'SECURITY_DISABLE_PIN') {
        const existingHash = await SecureStore.getItemAsync('tijarati_pin_hash');
        if (existingHash) {
          const pin = String(payload?.pin || '').trim();
          if (pin.length < 4) {
            result = { success: false, error: 'PIN_REQUIRED' };
          } else {
            const enteredHash = await hashPin(pin);
            if (enteredHash !== existingHash) {
              result = { success: false, error: 'PIN_WRONG' };
            } else {
              await SecureStore.deleteItemAsync('tijarati_pin_hash');
              await SecureStore.setItemAsync('tijarati_bio_enabled', '0');
              setPinEnabled(false);
              setBiometricEnabled(false);
              setLocked(false);
              result = { success: true };
            }
          }
        } else {
          // Nothing to disable
          await SecureStore.setItemAsync('tijarati_bio_enabled', '0');
          setPinEnabled(false);
          setBiometricEnabled(false);
          setLocked(false);
          result = { success: true };
        }
      } else if (type === 'SECURITY_SET_BIOMETRIC') {
        const enabled = !!payload?.enabled;
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        const available = !!hasHardware && !!enrolled;
        setBiometricsAvailable(available);

        if (enabled && !pinEnabled) {
          result = { success: false, error: 'Enable PIN first' };
        } else if (enabled && !available) {
          result = { success: false, error: 'Biometrics not available' };
        } else {
          await SecureStore.setItemAsync('tijarati_bio_enabled', enabled ? '1' : '0');
          setBiometricEnabled(enabled);
          result = { success: true };
        }
      }

      if (type === 'GET_TRANSACTIONS') {
        const db = await getDb();
        const rows = await db.getAllAsync('SELECT * FROM transactions ORDER BY date DESC');
        // Map DB schema -> v3 UI schema
        result = (rows || []).map((r) => ({
          id: r.id,
          type: r.type,
          item: r.item,
          quantity: Number(r.quantity ?? 1),
          unitPriceBase: Number(r.unitPrice ?? 0),
          amountBase: Number(r.amount ?? 0),
          pricingMode: r.pricingMode ?? 'unit',
          date: r.date,
          isCredit: !!r.isCredit,
          clientName: r.clientName ?? '',
          paidAmountBase: Number(r.paidAmount ?? 0),
          isFullyPaid: !!r.isFullyPaid,
          currency: r.currency ?? 'MAD',
          createdAt: Number(r.createdAt ?? 0),
          dueDate: r.dueDate ?? '',
          reminderId: r.reminderId ?? null,
          isInstallmentPlan: !!r.isInstallmentPlan,
          installments: (() => {
            try {
              const raw = r.installments;
              if (!raw) return [];
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })(),
          isMock: !!r.isMock,
        }));
      } else if (type === 'SAVE_TRANSACTION') {
        const tx = payload;
        const installmentsJson = (() => {
          try {
            return JSON.stringify(Array.isArray(tx.installments) ? tx.installments : []);
          } catch {
            return '[]';
          }
        })();
        const db = await getDb();
        await db.runAsync(
          'INSERT OR REPLACE INTO transactions (id, type, item, amount, quantity, unitPrice, pricingMode, date, isCredit, clientName, paidAmount, isFullyPaid, currency, createdAt, dueDate, reminderId, isInstallmentPlan, installments, isMock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            String(tx.id),
            String(tx.type ?? ''),
            String(tx.item ?? ''),
            Number(tx.amountBase ?? tx.amount ?? 0),
            Number(tx.quantity ?? 1),
            Number(tx.unitPriceBase ?? tx.unitPrice ?? 0),
            String(tx.pricingMode ?? 'unit'),
            String(tx.date ?? ''),
            tx.isCredit ? 1 : 0,
            String(tx.clientName ?? ''),
            Number(tx.paidAmountBase ?? tx.paidAmount ?? 0),
            tx.isFullyPaid ? 1 : 0,
            String(tx.currency ?? 'MAD'),
            Number(tx.createdAt ?? Date.now()),
            String(tx.dueDate ?? ''),
            tx.reminderId ? String(tx.reminderId) : null,
            tx.isInstallmentPlan ? 1 : 0,
            installmentsJson,
            0,
          ]
        );
        result = { success: true };
      } else if (type === 'GET_PARTNERS') {
        const db = await getDb();
        const rows = await db.getAllAsync('SELECT * FROM partners');
        result = (rows || []).map((r) => {
          let payouts = [];
          const raw = r?.payouts;
          if (typeof raw === 'string' && raw.trim()) {
            try {
              const parsed = JSON.parse(raw);
              payouts = Array.isArray(parsed) ? parsed : [];
            } catch {
              payouts = [];
            }
          } else if (Array.isArray(raw)) {
            payouts = raw;
          }
          return {
            ...r,
            profitSchedule: r?.profitSchedule ?? '',
            notes: r?.notes ?? '',
            payouts,
          };
        });
      } else if (type === 'SAVE_PARTNER') {
        const p = payload;
        const payoutsJson = (() => {
          try {
            return JSON.stringify(Array.isArray(p?.payouts) ? p.payouts : []);
          } catch {
            return '[]';
          }
        })();
        // Preserve explicit id when provided (older bundles didn't)
        const idNum = (p && p.id !== undefined && p.id !== null) ? Number(p.id) : null;
        const db = await getDb();
        if (idNum !== null && Number.isFinite(idNum)) {
          await db.runAsync(
            'INSERT OR REPLACE INTO partners (id, name, percent, createdAt, investedBase, investedAt, profitSchedule, notes, payouts, isMock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [idNum, p.name, p.percent, p.createdAt ?? Date.now(), Number(p.investedBase ?? 0), p.investedAt ? String(p.investedAt) : '', String(p.profitSchedule ?? ''), String(p.notes ?? ''), payoutsJson, 0]
          );
        } else {
          await db.runAsync(
            'INSERT INTO partners (name, percent, createdAt, investedBase, investedAt, profitSchedule, notes, payouts, isMock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [p.name, p.percent, p.createdAt ?? Date.now(), Number(p.investedBase ?? 0), p.investedAt ? String(p.investedAt) : '', String(p.profitSchedule ?? ''), String(p.notes ?? ''), payoutsJson, 0]
          );
        }
        result = { success: true };
      } else if (type === 'DELETE_PARTNER') {
        const db = await getDb();
        await db.runAsync('DELETE FROM partners WHERE id = ?', [payload.id]);
        result = { success: true };
      } else if (type === 'DELETE_TRANSACTION') {
        // Best-effort: cancel scheduled reminder if present
        try {
          const db = await getDb();
          const row = await db.getFirstAsync('SELECT reminderId FROM transactions WHERE id = ?', [payload.id]);
          const reminderId = row?.reminderId;
          if (reminderId) {
            try { await Notifications.cancelScheduledNotificationAsync(String(reminderId)); } catch { }
          }
        } catch { }
        {
          const db = await getDb();
          await db.runAsync('DELETE FROM transactions WHERE id = ?', [payload.id]);
        }
        result = { success: true };
      } else if (type === 'SCHEDULE_DEBT_REMINDER') {
        const ts = Number(payload?.timestamp);
        const title = String(payload?.title ?? 'Debt reminder');
        const body = String(payload?.body ?? '');
        if (!ts || Number.isNaN(ts)) {
          result = { success: false, error: 'Invalid timestamp' };
        } else {
          try {
            const now = Date.now();
            const diffMs = ts - now;
            const diffSeconds = Math.ceil(diffMs / 1000);
            if (!Number.isFinite(diffSeconds) || diffSeconds < 5) {
              result = { success: false, error: 'Reminder time must be in the future' };
            } else {
            const id = await Notifications.scheduleNotificationAsync({
              content: {
                title,
                body,
                sound: true,
                data: { txId: payload?.txId ?? null },
                ...(Platform.OS === 'android' ? { channelId: 'debts' } : {}),
              },
              // Use time interval trigger for reliability across Android OEMs/WebView bridges.
              trigger: { seconds: diffSeconds, repeats: false },
            });
            result = { success: true, reminderId: id };
            }
          } catch (err) {
            result = { success: false, error: String(err?.message || err) };
          }
        }
      } else if (type === 'CANCEL_DEBT_REMINDER') {
        try {
          const reminderId = payload?.id;
          if (reminderId) {
            await Notifications.cancelScheduledNotificationAsync(String(reminderId));
          }
          result = { success: true };
        } catch (err) {
          result = { success: false, error: String(err?.message || err) };
        }
      } else if (type === 'CLEAR_ALL_DATA') {
        // Cancel all scheduled reminders stored in DB
        try {
          const db = await getDb();
          const reminderRows = await db.getAllAsync("SELECT reminderId FROM transactions WHERE reminderId IS NOT NULL AND reminderId != ''");
          for (const r of reminderRows || []) {
            const rid = r?.reminderId;
            if (!rid) continue;
            try { await Notifications.cancelScheduledNotificationAsync(String(rid)); } catch { }
          }
        } catch { }

        const db = await getDb();
        await db.runAsync('BEGIN');
        try {
          await db.runAsync('DELETE FROM transactions');
          await db.runAsync('DELETE FROM partners');
          // Reset autoincrement counter (safe even if table missing in sqlite_sequence)
          try {
            await db.runAsync("DELETE FROM sqlite_sequence WHERE name = 'partners'");
          } catch { }
          await db.runAsync('COMMIT');
          result = { success: true };
        } catch (err) {
          try { await db.runAsync('ROLLBACK'); } catch { }
          result = { success: false, error: String(err?.message || err) };
        }
      } else if (type === 'IMPORT_DATA') {
        const incoming = payload?.content
          ? JSON.parse(payload.content)
          : (payload?.state ?? payload);

        const transactions = Array.isArray(incoming?.transactions) ? incoming.transactions : [];
        const partners = Array.isArray(incoming?.partners) ? incoming.partners : [];

        // Cancel previously scheduled reminders stored in DB (best-effort)
        try {
          const db = await getDb();
          const reminderRows = await db.getAllAsync("SELECT reminderId FROM transactions WHERE reminderId IS NOT NULL AND reminderId != ''");
          for (const r of reminderRows || []) {
            const rid = r?.reminderId;
            if (!rid) continue;
            try { await Notifications.cancelScheduledNotificationAsync(String(rid)); } catch { }
          }
        } catch { }

        const db = await getDb();
        await db.runAsync('BEGIN');
        try {
          await db.runAsync('DELETE FROM transactions');
          await db.runAsync('DELETE FROM partners');

          for (const p of partners) {
            if (!p) continue;
            const name = String(p.name ?? '').trim();
            if (!name) continue;
            const percent = Number(p.percent ?? 0);
            const createdAt = Number(p.createdAt ?? Date.now());
            const investedBase = Number(p.investedBase ?? 0);
            const investedAt = p.investedAt ? String(p.investedAt) : '';
            const profitSchedule = String(p.profitSchedule ?? '');
            const notes = String(p.notes ?? '');
            const payoutsJson = (() => {
              try {
                return JSON.stringify(Array.isArray(p?.payouts) ? p.payouts : []);
              } catch {
                return '[]';
              }
            })();

            // Preserve imported id when present so future deletes match.
            if (p.id !== undefined && p.id !== null && p.id !== '') {
              const idNum = Number(p.id);
              if (!Number.isNaN(idNum)) {
                await db.runAsync(
                  'INSERT OR REPLACE INTO partners (id, name, percent, createdAt, investedBase, investedAt, profitSchedule, notes, payouts, isMock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                  [idNum, name, percent, createdAt, investedBase, investedAt, profitSchedule, notes, payoutsJson, 0]
                );
                continue;
              }
            }

            await db.runAsync(
              'INSERT INTO partners (name, percent, createdAt, investedBase, investedAt, profitSchedule, notes, payouts, isMock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [name, percent, createdAt, investedBase, investedAt, profitSchedule, notes, payoutsJson, 0]
            );
          }

          for (const tx of transactions) {
            if (!tx) continue;
            const txId = String(tx.id ?? '').trim();
            if (!txId) continue;

            const installmentsJson = (() => {
              try {
                return JSON.stringify(Array.isArray(tx.installments) ? tx.installments : []);
              } catch {
                return '[]';
              }
            })();

            await db.runAsync(
              'INSERT OR REPLACE INTO transactions (id, type, item, amount, quantity, unitPrice, pricingMode, date, isCredit, clientName, paidAmount, isFullyPaid, currency, createdAt, dueDate, reminderId, isInstallmentPlan, installments, isMock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [
                txId,
                String(tx.type ?? ''),
                String(tx.item ?? ''),
                Number(tx.amountBase ?? tx.amount ?? 0),
                Number(tx.quantity ?? 1),
                Number(tx.unitPriceBase ?? tx.unitPrice ?? 0),
                String(tx.pricingMode ?? 'unit'),
                String(tx.date ?? ''),
                tx.isCredit ? 1 : 0,
                String(tx.clientName ?? ''),
                Number(tx.paidAmountBase ?? tx.paidAmount ?? 0),
                tx.isFullyPaid ? 1 : 0,
                String(tx.currency ?? ''),
                Number(tx.createdAt ?? Date.now()),
                String(tx.dueDate ?? ''),
                tx.reminderId ? String(tx.reminderId) : null,
                tx.isInstallmentPlan ? 1 : 0,
                installmentsJson,
                0,
              ]
            );
          }

          // Ensure next AUTOINCREMENT doesn't collide
          try {
            const maxPartnerId = (await db.getFirstAsync('SELECT MAX(id) as maxId FROM partners'))?.maxId;
            if (maxPartnerId) {
              await db.runAsync(
                "INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('partners', ?)",
                [Number(maxPartnerId)]
              );
            }
          } catch { }

          await db.runAsync('COMMIT');
          result = { success: true, counts: { partners: partners.length, transactions: transactions.length } };
        } catch (err) {
          try { await db.runAsync('ROLLBACK'); } catch { }
          result = { success: false, error: String(err?.message || err) };
        }
      } else if (type === 'OPEN_EXTERNAL') {
        const rawUrl = payload?.url;
        const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
        // Prevent Android FileUriExposed errors for internal WebView base URLs.
        const isSafeExternal =
          url.startsWith('http://') ||
          url.startsWith('https://') ||
          url.startsWith('mailto:') ||
          url.startsWith('tel:');
        if (!url || !isSafeExternal) {
          console.warn('Blocked OPEN_EXTERNAL url:', url);
          return;
        }
        Linking.openURL(url);
        return;
      } else if (type === 'SHARE_TEXT') {
        const title = String(payload?.title ?? 'Receipt');
        const text = String(payload?.text ?? '');
        const safeBase = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'receipt';
        const fileName = `${safeBase}_${Date.now()}.txt`;
        const fileUri = FileSystem.documentDirectory + fileName;
        await FileSystem.writeAsStringAsync(fileUri, text, { encoding: FileSystem.EncodingType.UTF8 });

        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri);
          result = { success: true, message: 'Shared' };
        } else {
          result = { success: false, message: 'Sharing is not available on this device' };
        }
      } else if (type === 'SAVE_FILE') {
        const fileName = payload.fileName || 'tijarati_backup.json';
        const mimeType = payload.mimeType || (String(fileName).toLowerCase().endsWith('.txt') ? 'text/plain' : 'application/json');
        const fileUri = FileSystem.documentDirectory + fileName;
        await FileSystem.writeAsStringAsync(fileUri, payload.content, { encoding: FileSystem.EncodingType.UTF8 });

        // On newer Android versions, MediaLibrary APIs are restricted and are meant for media.
        // For JSON backups, use SAF (user picks Download/Documents), otherwise fall back to share.
        if (Platform.OS === 'android') {
          const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (permissions.granted) {
            const targetUri = await FileSystem.StorageAccessFramework.createFileAsync(
              permissions.directoryUri,
              fileName,
              mimeType
            );
            await FileSystem.writeAsStringAsync(targetUri, payload.content, { encoding: FileSystem.EncodingType.UTF8 });
            result = { success: true, message: 'File saved' };
          } else {
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(fileUri);
              result = { success: true, message: 'File shared' };
            } else {
              result = { success: false, message: 'Sharing is not available on this device' };
            }
          }
        } else {
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(fileUri);
            result = { success: true, message: 'File shared' };
          } else {
            result = { success: false, message: 'Sharing is not available on this device' };
          }
        }
      } else if (type === 'PICK_FILE') {
        const doc = await DocumentPicker.getDocumentAsync({ type: 'application/json' });
        if (doc.canceled === false && doc.assets && doc.assets[0]) {
          const content = await FileSystem.readAsStringAsync(doc.assets[0].uri);
          result = { success: true, content };
        } else {
          result = { success: false };
        }
      }

      // Note: response is injected in finally
    } catch (e) {
      const msg = String(e?.message || e || '');

      // Treat "no backup yet" as a normal condition (not a failure).
      if (msg.includes('storage/object-not-found')) {
        if (!result) {
          if (type === 'CLOUD_STATUS') {
            const u = firebaseAuth ? firebaseAuth.currentUser : null;
            result = { success: true, user: mapUser(u), manifest: null };
          } else if (type === 'CLOUD_RESTORE') {
            const u = firebaseAuth ? firebaseAuth.currentUser : null;
            result = { success: true, user: mapUser(u), snapshot: null, manifest: null };
          } else {
            // For any other call, still respond with an error payload but don't spam logs.
            result = { success: false, error: msg };
          }
        }
      } else {
        console.error(e);
        if (!result) result = { success: false, error: msg };
      }
    } finally {
      // Always respond to avoid leaving the WebView awaiting forever.
      if (id && webViewRef.current) {
        const responsePayload = JSON.stringify({ id, result })
          // Prevent rare JS parse failures when payload contains Unicode line separators.
          // These can appear in imported text and break injected JavaScript.
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029');

        const responseJS = `window.postMessage(${responsePayload}); true;`;
        webViewRef.current.injectJavaScript(responseJS);
      }
    }
  };

  const LockScreen = () => {
    if (!locked) return null;

    const onDigit = (d) => {
      const digit = String(d);
      if (!/^[0-9]$/.test(digit)) return;
      setLockError('');
      setPinInput((prev) => {
        const cur = String(prev || '');
        if (cur.length >= 12) return cur;
        return cur + digit;
      });
    };

    const onBackspace = () => {
      setLockError('');
      setPinInput((prev) => String(prev || '').slice(0, -1));
    };

    const canUseBio = !!(biometricEnabled && biometricsAvailable);
    const filledDots = Math.min(String(pinInput || '').length, 6);

    return (
      <View style={[styles.lockWrap, { backgroundColor: isDark ? '#070b16' : '#f7f7fb' }]} pointerEvents="auto">
        <View style={[styles.lockCard, { backgroundColor: isDark ? '#0b1326' : '#ffffff', borderColor: isDark ? '#1b2a4a' : '#e2e8f0' }]}>
          <View style={styles.lockHeader}>
            <View style={[styles.lockBadge, { backgroundColor: isDark ? '#0f1b36' : '#f1f5f9', borderColor: isDark ? '#1b2a4a' : '#e2e8f0' }]}>
              <Text style={[styles.lockBadgeText, { color: isDark ? '#14b8a6' : '#0f766e' }]}>TIJARATI</Text>
            </View>
            <Text style={[styles.lockTitle, { color: isDark ? '#e5e7eb' : '#0f172a' }]}>App locked</Text>
            <Text style={[styles.lockSub, { color: isDark ? '#9aa4b2' : '#64748b' }]}>Enter your PIN to continue</Text>
          </View>

          <View style={styles.lockDotsRow}>
            {Array.from({ length: 6 }).map((_, i) => (
              <View
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                style={[
                  styles.lockDot,
                  {
                    backgroundColor:
                      i < filledDots
                        ? (isDark ? '#14b8a6' : '#0f766e')
                        : (isDark ? '#0f1b36' : '#f1f5f9'),
                    borderColor: isDark ? '#1b2a4a' : '#e2e8f0',
                  },
                ]}
              />
            ))}
          </View>

          {lockError ? <Text style={styles.lockError}>{lockError}</Text> : null}

          <View style={styles.lockActionsRow}>
            {canUseBio ? (
              <Pressable
                style={[styles.lockActionPill, { backgroundColor: isDark ? '#0f1b36' : '#f1f5f9', borderColor: isDark ? '#1b2a4a' : '#e2e8f0' }]}
                onPress={tryBiometricUnlock}
              >
                <Text style={[styles.lockActionPillText, { color: isDark ? '#e5e7eb' : '#0f172a' }]}>Use fingerprint</Text>
              </Pressable>
            ) : null}

            <Pressable
              style={[styles.lockActionPill, { backgroundColor: isDark ? '#0f1b36' : '#f1f5f9', borderColor: isDark ? '#1b2a4a' : '#e2e8f0' }]}
              onPress={() => { setPinInput(''); setLockError(''); }}
            >
              <Text style={[styles.lockActionPillText, { color: isDark ? '#e5e7eb' : '#0f172a' }]}>Clear</Text>
            </Pressable>
          </View>

          <View style={styles.lockKeypad}>
            {[
              ['1', '2', '3'],
              ['4', '5', '6'],
              ['7', '8', '9'],
              ['back', '0', 'ok'],
            ].map((row, r) => (
              // eslint-disable-next-line react/no-array-index-key
              <View key={r} style={styles.lockKeypadRow}>
                {row.map((k) => {
                  if (k === 'back') {
                    return (
                      <Pressable
                        key={k}
                        style={[styles.lockKey, { backgroundColor: isDark ? '#0f1b36' : '#f1f5f9', borderColor: isDark ? '#1b2a4a' : '#e2e8f0' }]}
                        onPress={onBackspace}
                        onLongPress={() => setPinInput('')}
                      >
                        <Text style={[styles.lockKeyAlt, { color: isDark ? '#e5e7eb' : '#0f172a' }]}>⌫</Text>
                      </Pressable>
                    );
                  }

                  if (k === 'ok') {
                    return (
                      <Pressable
                        key={k}
                        style={[styles.lockKey, { backgroundColor: '#14b8a6', borderColor: 'rgba(20,184,166,0.35)' }]}
                        onPress={unlockWithPin}
                      >
                        <Text style={styles.lockKeyOk}>OK</Text>
                      </Pressable>
                    );
                  }

                  return (
                    <Pressable
                      key={k}
                      style={[styles.lockKey, { backgroundColor: isDark ? '#0f1b36' : '#ffffff', borderColor: isDark ? '#1b2a4a' : '#e2e8f0' }]}
                      onPress={() => onDigit(k)}
                    >
                      <Text style={[styles.lockKeyText, { color: isDark ? '#e5e7eb' : '#0f172a' }]}>{k}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>

          {/* Keep a hidden input to support password managers / accessibility keyboards if needed */}
          <TextInput
            value={pinInput}
            onChangeText={(v) => { setPinInput(String(v || '').replace(/[^0-9]/g, '')); setLockError(''); }}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={12}
            style={styles.lockHiddenInput}
            onSubmitEditing={unlockWithPin}
            returnKeyType="done"
          />
        </View>
      </View>
    );
  };

  const initialJS = `
    window.isNativeApp = true;
    window.systemTheme = '${colorScheme}';
    if ('${colorScheme}' === 'dark') document.documentElement.classList.add('dark');

    // Optional hosted backend for AI (so preview/production builds work without a local server).
    window.__TIJARATI_AI_SERVER_URL__ = ${JSON.stringify(aiServerUrl)};

    // Native request/response bridge (no CORS; used for direct Gemini calls, file save/share, etc).
    window.__TIJARATI_NATIVE_REQUEST__ = function(type, payload) {
      return new Promise((resolve) => {
        try {
          if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
            resolve({ success: false, error: 'Native bridge unavailable' });
            return;
          }
          const id = Date.now() + Math.random().toString();
          const handler = (event) => {
            let data = event && event.data;
            try {
              if (typeof data === 'string') data = JSON.parse(data);
            } catch (e) {}
            if (data && data.id === id) {
              document.removeEventListener('message', handler);
              window.removeEventListener('message', handler);
              resolve(data.result);
            }
          };
          document.addEventListener('message', handler);
          window.addEventListener('message', handler);
          window.ReactNativeWebView.postMessage(JSON.stringify({ id, type, payload }));
        } catch (e) {
          resolve({ success: false, error: String(e && (e.message || e) || 'Native bridge failed') });
        }
      });
    };

    (function patchNativeImportClear() {
      function nativeRequest(type, payload) {
        return new Promise((resolve) => {
          const id = Date.now() + Math.random().toString();
          const handler = (event) => {
            let data = event && event.data;
            try {
              if (typeof data === 'string') data = JSON.parse(data);
            } catch (e) {}
            if (data && data.id === id) {
              document.removeEventListener('message', handler);
              window.removeEventListener('message', handler);
              resolve(data.result);
            }
          };
          document.addEventListener('message', handler);
          window.addEventListener('message', handler);
          window.ReactNativeWebView.postMessage(JSON.stringify({ id, type, payload }));
        });
      }

      function tryPatch() {
        if (!window.isNativeApp) return;
        if (!window.ReactNativeWebView) return;

        // Patch Clear Data
        // Clear data is handled by the web UI (calls API.clearAllData()).

        // Patch Import (import into SQLite first, then apply to local state)
        if (typeof window.processImport === 'function' && !window.processImport.__nativePatched) {
          const originalProcessImport = window.processImport;
          const patchedProcessImport = async function (content, event) {
            try {
              const incoming = JSON.parse(String(content || '{}'));
              const res = await nativeRequest('IMPORT_DATA', { state: incoming });
              if (!res || !res.success) {
                if (typeof window.showToast === 'function') window.showToast('Import failed', 'error');
                if (event && event.target) event.target.value = '';
                return;
              }
            } catch (e) {
              // Fall through to existing error handling (Invalid file)
            }
            return originalProcessImport(content, event);
          };
          patchedProcessImport.__nativePatched = true;
          window.processImport = patchedProcessImport;
        }
      }

      // Poll briefly because the bundle defines functions after load
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        tryPatch();
        if (window.processImport && window.processImport.__nativePatched) {
          clearInterval(timer);
        }
        if (attempts > 200) clearInterval(timer);
      }, 50);
    })();

    true;
  `;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.container, { backgroundColor: themeColor }]} edges={['top', 'bottom', 'left', 'right']}>
        <StatusBar style={isDark ? "light" : "light"} backgroundColor={themeColor} />
        <View style={{ flex: 1 }}>
          <WebView
            ref={webViewRef}
            source={htmlSource}
            style={[styles.webview, { backgroundColor: isDark ? '#111827' : '#F3F4F6' }]}
            javaScriptEnabled={true}
            onMessage={handleMessage}
            injectedJavaScriptBeforeContentLoaded={initialJS}
            onError={(e) => console.warn('WebView Error', e.nativeEvent)}
          />
          <LockScreen />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  lockWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  lockCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
  },
  lockHeader: {
    alignItems: 'center',
    paddingTop: 6,
    paddingBottom: 10,
  },
  lockBadge: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    marginBottom: 10,
  },
  lockBadgeText: {
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
  },
  lockTitle: {
    fontSize: 22,
    fontWeight: '900',
    marginBottom: 6,
  },
  lockSub: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 0,
    textAlign: 'center',
  },
  lockDotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    paddingTop: 10,
    paddingBottom: 6,
  },
  lockDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
  lockActionsRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    marginTop: 10,
  },
  lockActionPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  lockActionPillText: {
    fontWeight: '900',
    fontSize: 12,
  },
  lockKeypad: {
    marginTop: 14,
  },
  lockKeypadRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  lockKey: {
    flex: 1,
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockKeyText: {
    fontSize: 18,
    fontWeight: '900',
  },
  lockKeyAlt: {
    fontSize: 18,
    fontWeight: '900',
  },
  lockKeyOk: {
    fontSize: 14,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  lockHiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 0,
    width: 0,
  },
  lockError: {
    color: '#ef4444',
    fontWeight: '800',
    marginTop: 8,
    fontSize: 12,
    textAlign: 'center',
  },
});
