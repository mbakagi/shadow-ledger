/* Shadow Ledger — Firebase init (modular SDK v12+).
 * Same production project as the legacy pages (ledger-d57da). */
import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore
} from 'firebase/firestore';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  type Auth,
  type User
} from 'firebase/auth';

export const firebaseConfig = {
  apiKey: 'AIzaSyDBPAF8LeDCfywbFiWSMHeu01inc_uxSk0',
  authDomain: 'ledger-d57da.firebaseapp.com',
  projectId: 'ledger-d57da',
  storageBucket: 'ledger-d57da.firebasestorage.app',
  messagingSenderId: '713000868232',
  appId: '1:713000868232:web:b979ddfaa854ea80d5023d'
};

const app = initializeApp(firebaseConfig);

/* Offline persistence via IndexedDB (multi-tab safe). */
export const db: Firestore = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export const auth: Auth = getAuth(app);

const EMAIL_KEY = 'sl-email-for-link';

export function onUser(cb: (u: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}

/** Anonymous session — the default worker identity. */
export async function ensureAuth(): Promise<User> {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

/** Email + password sign-in (matches the legacy app's Firebase users). */
export async function signInEmailPassword(email: string, password: string): Promise<User> {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/** Email-link (passwordless) sign-in for elevated users. */
export async function sendEmailLink(email: string): Promise<void> {
  await sendSignInLinkToEmail(auth, email, {
    url: location.origin + location.pathname,
    handleCodeInApp: true
  });
  localStorage.setItem(EMAIL_KEY, email);
}

/** Call on load; completes sign-in if the current URL is an email link. */
export async function completeEmailLink(): Promise<User | null> {
  if (!isSignInWithEmailLink(auth, location.href)) return null;
  let email = localStorage.getItem(EMAIL_KEY) ?? '';
  if (!email) email = prompt('Confirm your email to finish sign-in:') ?? '';
  if (!email) return null;
  const cred = await signInWithEmailLink(auth, email, location.href);
  localStorage.removeItem(EMAIL_KEY);
  return cred.user;
}
