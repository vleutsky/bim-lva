/**
 * BIM.LVA Auth UI — кнопка входа + модалка регистрации/логина.
 * Подключайте после auth-config.js и auth.js:
 *   <script src="./auth-config.js"></script>
 *   <script src="./auth.js"></script>
 *   <script src="./auth-ui.js"></script>
 *   <div data-bimlva-auth-slot></div>  — опциональный слот в шапке
 */
(function () {
  'use strict';

  if (document.getElementById('bimlva-auth-style')) return;

  const style = document.createElement('style');
  style.id = 'bimlva-auth-style';
  style.textContent = `
    .bimlva-auth-btn {
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.08);
      color: #fff;
      padding: 7px 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
      transition: .15s;
    }
    .bimlva-auth-btn:hover { background: rgba(255,255,255,.16); }
    .bimlva-auth-btn.light {
      border-color: #d2d9e2;
      background: #fff;
      color: #1c2733;
    }
    .bimlva-auth-btn.light:hover { border-color: #2478b5; color: #2478b5; }
    .bimlva-auth-user {
      font-size: 12px;
      font-weight: 600;
      opacity: .9;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bimlva-auth-backdrop {
      position: fixed; inset: 0; z-index: 2000;
      background: rgba(15, 23, 42, .55);
      display: none; align-items: center; justify-content: center;
      padding: 16px;
    }
    .bimlva-auth-backdrop.show { display: flex; }
    .bimlva-auth-modal {
      width: min(420px, 100%);
      background: #fff;
      color: #1c2733;
      border-radius: 14px;
      border: 1px solid #d2d9e2;
      box-shadow: 0 20px 50px rgba(15,23,42,.25);
      overflow: hidden;
      font-family: 'Archivo', system-ui, sans-serif;
    }
    .bimlva-auth-modal header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px; border-bottom: 1px solid #e8edf3;
    }
    .bimlva-auth-modal header h3 { font-size: 15px; font-weight: 800; margin: 0; }
    .bimlva-auth-modal header button {
      border: 0; background: transparent; font-size: 18px; cursor: pointer; color: #6b7684;
    }
    .bimlva-auth-tabs { display: flex; gap: 4px; padding: 12px 16px 0; }
    .bimlva-auth-tabs button {
      flex: 1; border: 1px solid #d2d9e2; background: #f7f9fc; color: #6b7684;
      border-radius: 8px; padding: 8px; font-weight: 700; font-size: 12px; cursor: pointer;
    }
    .bimlva-auth-tabs button.on { background: #fff0e7; border-color: #f0c2a8; color: #c94a12; }
    .bimlva-auth-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
    .bimlva-auth-body label { font-size: 11px; font-weight: 700; color: #6b7684; letter-spacing: .04em; text-transform: uppercase; }
    .bimlva-auth-body input {
      width: 100%; box-sizing: border-box; margin-top: 4px;
      border: 1px solid #d2d9e2; border-radius: 8px; padding: 10px 12px;
      font-size: 14px; font-family: inherit;
    }
    .bimlva-auth-body input:focus { outline: none; border-color: #2478b5; }
    .bimlva-auth-submit {
      margin-top: 4px; border: 0; border-radius: 8px; padding: 11px 14px;
      background: #2478b5; color: #fff; font-weight: 700; font-size: 13px; cursor: pointer;
    }
    .bimlva-auth-submit:disabled { opacity: .5; cursor: default; }
    .bimlva-auth-note { font-size: 12px; color: #6b7684; line-height: 1.4; }
    .bimlva-auth-error { font-size: 12px; color: #d43c59; min-height: 16px; }
    .bimlva-auth-ok { font-size: 12px; color: #168c63; }
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'bimlva-auth-backdrop';
  backdrop.id = 'bimlvaAuthBackdrop';
  backdrop.innerHTML = `
    <div class="bimlva-auth-modal" role="dialog" aria-modal="true" aria-labelledby="bimlvaAuthTitle">
      <header>
        <h3 id="bimlvaAuthTitle">Аккаунт BIM.LVA</h3>
        <button type="button" id="bimlvaAuthClose" aria-label="Закрыть">×</button>
      </header>
      <div class="bimlva-auth-tabs">
        <button type="button" class="on" data-tab="login">Вход</button>
        <button type="button" data-tab="register">Регистрация</button>
      </div>
      <form class="bimlva-auth-body" id="bimlvaAuthForm">
        <div data-reg-only style="display:none">
          <label>Имя<input name="name" type="text" autocomplete="name" placeholder="Как к вам обращаться"></label>
        </div>
        <div>
          <label>Email<input name="email" type="email" required autocomplete="email" placeholder="name@company.ru"></label>
        </div>
        <div data-reg-only style="display:none">
          <label>Telegram (необязательно)<input name="telegram" type="text" autocomplete="off" placeholder="@username"></label>
        </div>
        <div>
          <label>Пароль<input name="password" type="password" required autocomplete="current-password" placeholder="минимум 6 символов"></label>
        </div>
        <div class="bimlva-auth-error" id="bimlvaAuthError"></div>
        <button class="bimlva-auth-submit" type="submit" id="bimlvaAuthSubmit">Войти</button>
        <p class="bimlva-auth-note" id="bimlvaAuthNote"></p>
      </form>
    </div>
  `;
  document.body.appendChild(backdrop);

  let tab = 'login';
  const form = backdrop.querySelector('#bimlvaAuthForm');
  const errEl = backdrop.querySelector('#bimlvaAuthError');
  const noteEl = backdrop.querySelector('#bimlvaAuthNote');
  const submitBtn = backdrop.querySelector('#bimlvaAuthSubmit');

  function setTab(next) {
    tab = next;
    backdrop.querySelectorAll('.bimlva-auth-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    backdrop.querySelectorAll('[data-reg-only]').forEach((el) => {
      el.style.display = tab === 'register' ? '' : 'none';
    });
    form.password.autocomplete = tab === 'register' ? 'new-password' : 'current-password';
    submitBtn.textContent = tab === 'register' ? 'Создать аккаунт' : 'Войти';
    errEl.textContent = '';
    updateNote();
  }

  function updateNote() {
    const auth = window.BimLvaAuth;
    if (!auth) return;
    const m = auth.mode();
    noteEl.textContent = m === 'supabase'
      ? 'Облачный аккаунт (Supabase). Письмо подтверждения может прийти на email.'
      : 'Локальный режим: аккаунт хранится в этом браузере. Для общей базы пользователей укажите Supabase в auth-config.js.';
  }

  function openAuth(initialTab) {
    setTab(initialTab === 'register' ? 'register' : 'login');
    backdrop.classList.add('show');
    setTimeout(() => form.email?.focus(), 30);
  }

  function closeAuth() {
    backdrop.classList.remove('show');
    errEl.textContent = '';
  }

  backdrop.querySelector('#bimlvaAuthClose').addEventListener('click', closeAuth);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAuth(); });
  backdrop.querySelectorAll('.bimlva-auth-tabs button').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('show')) closeAuth();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const auth = window.BimLvaAuth;
    if (!auth) return;
    errEl.textContent = '';
    submitBtn.disabled = true;
    const payload = {
      email: form.email.value,
      password: form.password.value,
      name: form.name.value,
      telegram: form.telegram.value
    };
    try {
      if (tab === 'register') {
        const res = await auth.register(payload);
        if (res.needsEmailConfirm) {
          errEl.className = 'bimlva-auth-ok';
          errEl.textContent = 'Аккаунт создан. Подтвердите email, затем войдите.';
          setTab('login');
        } else {
          closeAuth();
        }
      } else {
        await auth.login(payload);
        closeAuth();
      }
    } catch (err) {
      errEl.className = 'bimlva-auth-error';
      errEl.textContent = err.message || String(err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  function renderSlot(user) {
    const slots = document.querySelectorAll('[data-bimlva-auth-slot]');
    const onDarkNav = !!document.querySelector('nav.glass-dark');
    const btnClass = onDarkNav ? 'bimlva-auth-btn' : 'bimlva-auth-btn light';

    const html = user
      ? `<button type="button" class="${btnClass}" data-auth-menu title="${escapeHtml(user.email)}">
           <span class="bimlva-auth-user">${escapeHtml(user.name || user.email)}</span>
           <span aria-hidden="true">▾</span>
         </button>`
      : `<button type="button" class="${btnClass}" data-auth-open>Войти</button>
         <button type="button" class="${btnClass}" data-auth-register>Регистрация</button>`;

    if (slots.length) {
      slots.forEach((slot) => { slot.innerHTML = html; bindSlot(slot, user); });
      return;
    }

    let host = document.getElementById('bimlvaAuthAutoSlot');
    if (!host) {
      host = document.createElement('div');
      host.id = 'bimlvaAuthAutoSlot';
      host.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:8px;';
      const navInner = document.querySelector('nav .hidden.md\\:flex');
      const topEnd = document.querySelector('.tb-end') || document.querySelector('header.top');
      if (navInner) navInner.appendChild(host);
      else if (topEnd) topEnd.insertBefore(host, topEnd.firstChild);
      else return;
    }
    host.innerHTML = html;
    bindSlot(host, user);
  }

  function bindSlot(root, user) {
    root.querySelector('[data-auth-open]')?.addEventListener('click', () => openAuth('login'));
    root.querySelector('[data-auth-register]')?.addEventListener('click', () => openAuth('register'));
    root.querySelector('[data-auth-menu]')?.addEventListener('click', async () => {
      const name = user?.name || user?.email || '';
      const ok = confirm(`${name}\n${user?.email || ''}\n\nВыйти из аккаунта?`);
      if (ok) await window.BimLvaAuth.logout();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function boot() {
    if (!window.BimLvaAuth) return;
    await window.BimLvaAuth.init();
    renderSlot(window.BimLvaAuth.getUser());
    window.BimLvaAuth.onChange(renderSlot);
    updateNote();
  }

  window.BimLvaAuthUI = { open: openAuth, close: closeAuth };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
