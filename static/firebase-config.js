/* •••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••
   Shadow Ledger — Firebase Configuration
   ••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••• */

window.firebaseConfig = {
  apiKey:            "AIzaSyDBPAF8LeDCfywbFiWSMHeu01inc_uxSk0",
  authDomain:        "ledger-d57da.firebaseapp.com",
  projectId:         "ledger-d57da",
  storageBucket:     "ledger-d57da.firebasestorage.app",
  messagingSenderId: "713000868232",
  appId:             "1:713000868232:web:b979ddfaa854ea80d5023d"
};

// Legacy support for non-modular pages
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(window.firebaseConfig);

  /* Expose globals used by app.js */
  window.db   = firebase.firestore();
  window.auth = firebase.auth();

  /* Offline persistence so the app still works if Wi-Fi drops briefly */
  window.db.enablePersistence({ synchronizeTabs: true })
    .catch(err => {
      if (err.code === 'failed-precondition') {
        console.warn('Firestore persistence unavailable — multiple tabs open?');
      } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence not supported by this browser.');
      }
    });
}
