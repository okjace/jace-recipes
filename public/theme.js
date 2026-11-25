// Applies the saved light/dark choice before the page paints (no flash).
try {
  const t = localStorage.getItem('jr-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow the device */ }
