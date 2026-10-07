// Registers the offline app shell. Kept in its own file (instead of an inline
// <script>) so the Content-Security-Policy can forbid inline scripts.
// The Android / iPhone apps already carry their files inside the app.
if ('serviceWorker' in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js'));
}
