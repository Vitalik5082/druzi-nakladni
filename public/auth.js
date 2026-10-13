// Same raw-fetch-to-Supabase pattern druzi-menu's own #admin already uses — no SDK needed.
const SUPABASE_URL = 'https://vnzqgixjepdyjkmowjae.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_X__wnxBYauPbfeYIB51rMg_bbnw2Ijs';

function getToken() {
  try { return localStorage.getItem('druzi_admin_token'); } catch { return null; }
}

function setToken(token) {
  try { localStorage.setItem('druzi_admin_token', token); } catch {}
}

function clearToken() {
  try { localStorage.removeItem('druzi_admin_token'); } catch {}
}

// Call at the top of every protected page. Redirects to login if there's no token.
// (Server-side, the real protection is that every /api/* call requires this same token —
// this check is just so the viewer doesn't see a blank/broken page first.)
function requireAuth() {
  if (!getToken()) {
    window.location.href = 'login.html';
  }
}

// Drop-in replacement for fetch() that attaches the Supabase token. If the server says the
// token is invalid/expired, bounce to the login page instead of silently failing.
async function authFetch(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${getToken()}` };
  const res = await fetch(url, opts);
  if (res.status === 401) {
    clearToken();
    window.location.href = 'login.html';
    throw new Error('Unauthorized');
  }
  return res;
}
