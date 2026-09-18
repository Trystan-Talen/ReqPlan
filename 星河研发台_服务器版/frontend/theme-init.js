// Runs before first paint so a saved dark/light preference never flashes.
(function () {
  try {
    var saved = localStorage.getItem('xinghe:theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch (_) {}
})();
