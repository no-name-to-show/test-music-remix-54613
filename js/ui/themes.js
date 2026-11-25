/**
 * MixMaker · Theme selector.
 * Persists Dark, White and Purple and keeps the selector accessible.
 */
export function initializeThemes(select) {
  const themes = ['dark', 'white', 'purple'];
  const labels = { dark: 'Dark', white: 'White', purple: 'Purple' };

  function applyTheme(requested) {
    const theme = themes.includes(requested) ? requested : 'dark';
    document.documentElement.dataset.theme = theme;
    const button = select('#btnTheme');
    button.textContent = '◐  ' + labels[theme];
    button.setAttribute('aria-label', `Tema actual: ${labels[theme]}. Pulsa para cambiar`);
    button.title = 'Cambiar tema (Dark → White → Purple)';
    try { localStorage.setItem('mm-theme', theme); } catch {}
  }

  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('mm-theme') || 'dark'; } catch {}
  applyTheme(savedTheme);

  select('#btnTheme').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'dark';
    applyTheme(themes[(themes.indexOf(current) + 1) % themes.length]);
  });

  return { applyTheme, getCurrentTheme: () => document.documentElement.dataset.theme || 'dark' };
}
