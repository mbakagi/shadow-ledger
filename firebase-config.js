/* ═══════════════════════════════════════════════════════
   Shadow Ledger — Firebase Configuration
   ═══════════════════════════════════════════════════════ */

const firebaseConfig = {
  apiKey:            "AIzaSyDBPAF8LeDCfywbFiWSMHeu01inc_uxSk0",
  authDomain:        "ledger-d57da.firebaseapp.com",
  projectId:         "ledger-d57da",
  storageBucket:     "ledger-d57da.firebasestorage.app",
  messagingSenderId: "713000868232",
  appId:             "1:713000868232:web:b979ddfaa854ea80d5023d"
};

firebase.initializeApp(firebaseConfig);

/* Expose globals used by app.js */
const db   = firebase.firestore();
const auth = firebase.auth();

/* Offline persistence so the app still works if Wi-Fi drops briefly */
db.enablePersistence({ synchronizeTabs: true })
  .catch(err => {
    if (err.code === 'failed-precondition') {
      console.warn('Firestore persistence unavailable — multiple tabs open?');
    } else if (err.code === 'unimplemented') {
      console.warn('Firestore persistence not supported by this browser.');
    }
  });
