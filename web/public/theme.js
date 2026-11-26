// Applies this device's theme and accent before the first paint, so a reload never flashes the default look.
try {
  var root = document.documentElement
  if (localStorage.getItem('theme') === 'og') {
    root.dataset.theme = 'og'
    document.querySelector('meta[name="theme-color"]').setAttribute('content', '#121214')
  }
  if (localStorage.getItem('accent') === 'pink') root.dataset.accent = 'pink'
} catch (e) {}
