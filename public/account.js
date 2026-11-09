// Presentation: the account menu in the top right of the portfolio page. Shows who
// is logged in and logs out. The server already sent logged-out visitors to the
// login page, so a missing user here means the session just ended.
(() => {
  const $ = (id) => document.getElementById(id);
  const button = $('account-btn');
  const menu = $('account-menu');

  function setOpen(open) {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) $('logout-btn').focus();
  }

  button.addEventListener('click', () => setOpen(menu.hidden));
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('.account')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    $('logout-btn').disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      location.href = 'index.html';
    }
  });

  fetch('/api/auth/me')
    .then((r) => r.json())
    .then(({ user }) => {
      if (!user) {
        location.href = `login.html?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
        return;
      }
      $('account-name').textContent = user.username;
      $('account-menu-name').textContent = user.username;
      $('account-initial').textContent = user.username[0].toUpperCase();
      button.hidden = false;
    })
    .catch(() => {});
})();
