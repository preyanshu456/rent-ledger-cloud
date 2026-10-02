// Registers the offline app shell. Kept in its own file (instead of an inline
// <script>) so the Content-Security-Policy can forbid inline scripts.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js'));
}
