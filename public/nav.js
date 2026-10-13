const NAV_GROUPS = [
  {
    label: 'Накладні',
    links: [
      { key: 'recognition', href: 'index.html', label: 'Розпізнати накладну' },
      { key: 'invoices', href: 'invoices.html', label: 'Реєстр накладних' },
      { key: 'suppliers-list', href: 'suppliers.html', label: 'Постачальники' }
    ]
  },
  {
    label: 'Фінанси',
    links: [
      { key: 'cash', href: 'cash.html', label: 'Каса' },
      { key: 'expenses', href: 'expenses.html', label: 'Витрати' },
      { key: 'dashboard', href: 'dashboard.html', label: 'Прибуток' }
    ]
  },
  {
    label: 'Персонал',
    links: [
      { key: 'employees', href: 'employees.html', label: 'Працівники' },
      { key: 'payroll', href: 'payroll.html', label: 'ЗП' }
    ]
  },
  {
    label: 'Poster',
    links: [
      { key: 'sales', href: 'sales.html', label: 'Реалізація' },
      { key: 'techcards', href: 'techcards.html', label: 'Техкарти' },
      { key: 'leftovers', href: 'leftovers.html', label: 'Залишки' },
      { key: 'orders', href: 'orders.html', label: 'Рекомендації замовлень' },
      { key: 'product-suppliers', href: 'product-suppliers.html', label: 'Постачальники товарів' }
    ]
  },
  {
    label: 'Ревізії',
    links: [
      { key: 'revisions', href: 'revisions.html', label: 'Ревізії' }
    ]
  },
  {
    label: 'AI-чат',
    links: [
      { key: 'chat', href: 'chat.html', label: 'AI-чат' }
    ]
  }
];

function renderNav(active) {
  const root = document.getElementById('header-root');
  if (!root) return;

  const groups = NAV_GROUPS.map(group => {
    const isActiveGroup = group.links.some(l => l.key === active);
    const links = group.links.map(l =>
      `<a class="${l.key === active ? 'active' : ''}" href="${l.href}">${l.label}</a>`
    ).join('');

    // single-link groups (e.g. Ревізії) render as a plain link, not a dropdown
    if (group.links.length === 1) {
      const l = group.links[0];
      return `<a class="nav-top ${l.key === active ? 'active' : ''}" href="${l.href}">${group.label}</a>`;
    }

    return `
      <div class="nav-dropdown ${isActiveGroup ? 'active' : ''}">
        <span class="nav-top" onclick="toggleNavDropdown(event, this)">${group.label} <span class="nav-caret">▾</span></span>
        <div class="nav-panel"><div class="nav-panel-inner">${links}</div></div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <header>
      <div class="logo">invoice<span>.ai</span></div>
      <nav class="main-nav">${groups}</nav>
      <div style="display:flex;align-items:center;gap:14px">
        <div class="status-dot"><div class="dot"></div>Online</div>
        <a href="#" class="nav-top" onclick="logout(); return false;" style="padding:6px 10px">Вийти</a>
      </div>
    </header>
  `;
}

// Dropdowns open on :hover/:focus-within in CSS, which desktop mice get for free — but there's
// no hover state on a touchscreen and the trigger (a <span>) isn't focusable, so on mobile tapping
// a nav group did nothing. This adds an explicit tap-to-toggle that works alongside the CSS hover.
function toggleNavDropdown(event, el) {
  event.stopPropagation();
  const dropdown = el.closest('.nav-dropdown');
  const wasOpen = dropdown.classList.contains('open');
  document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
  if (!wasOpen) dropdown.classList.add('open');
}

document.addEventListener('click', () => {
  document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
});

function logout() {
  clearToken();
  window.location.href = 'login.html';
}
