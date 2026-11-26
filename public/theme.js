(() => {
  const key = 'perch.theme';
  const supported = new Set(['forest', 'blue', 'violet', 'white', 'night']);
  const root = document.documentElement;

  function apply(value) {
    const theme = supported.has(value) ? value : 'forest';
    root.dataset.theme = theme;
    const selected = document.querySelector(`#theme-choices input[value="${theme}"]`);
    if (selected) selected.checked = true;
  }

  try {
    apply(localStorage.getItem(key));
  } catch {
    apply('forest');
  }

  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });

  document.addEventListener('DOMContentLoaded', () => {
    const choices = document.getElementById('theme-choices');
    if (!choices) return;
    apply(root.dataset.theme);
    choices.addEventListener('change', event => {
      const theme = event.target.value;
      if (!supported.has(theme)) return;
      apply(theme);
      try {
        localStorage.setItem(key, theme);
      } catch {
        // The current page can still change color when persistent storage is unavailable.
      }
    });
  });
})();
