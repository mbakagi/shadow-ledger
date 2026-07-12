// proofinv — shared Firebase v9+ Modular SDK config
// Loaded AFTER firebase-app-compat + firebase-firestore-compat + firebase-auth-compat CDN scripts
// Exposes globals: db, auth (compat API)
(function () {
  const cfg = {
    apiKey: "AIzaSyDBPAF8LeDCfywbFiWSMHeu01inc_uxSk0",
    authDomain: "ledger-d57da.firebaseapp.com",
    projectId: "ledger-d57da",
    storageBucket: "ledger-d57da.firebasestorage.app",
    messagingSenderId: "713000868232",
    appId: "1:713000868232:web:b979ddfaa854ea80d5023d"
  };

  if (typeof firebase === 'undefined') {
    console.error('firebase-inv.js: compat SDK not loaded — add CDN scripts before this file');
    return;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(cfg);
  }

  window.db = firebase.firestore();
  window.auth = firebase.auth();

  window.db.enablePersistence({ synchronizeTabs: true }).catch(function (e) {
    if (e.code === 'failed-precondition' || e.code === 'unimplemented') {
      console.warn('Firestore persistence unavailable:', e.code);
    }
  });
})();