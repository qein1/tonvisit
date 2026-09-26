/**
 * ============================================================
 *  Главный модуль: рендерит страницу из CONFIG и управляет UI
 * ============================================================
 */

import { CONFIG } from './config.js';
import {
  createOrder,
  buildPaymentLink,
  buildWalletLink,
  buildTxLink,
  checkPayment,
  toRawAddress,
  updateOrder,
} from './ton.js';

/* Вендоренная библиотека генерации QR подключается обычным <script> в index.html
   и доступна как глобальная переменная window.qrcode — так не нужна сборка. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* Иконки услуг (инлайн, чтобы не тянуть икон-шрифты) */
const ICONS = {
  shield:
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z"/><path d="M12 17v5"/>',
  swap: '<path d="M17 3l4 4-4 4"/><path d="M21 7H9a4 4 0 0 0-4 4v1"/><path d="M7 21l-4-4 4-4"/><path d="M3 17h12a4 4 0 0 0 4-4v-1"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
};

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

const STAR_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

/**
 * Безопасная ссылка: пропускаем только ожидаемые протоколы.
 * Защищает от javascript: и мусора в конфиге.
 */
function safeUrl(url) {
  const value = String(url ?? '').trim();
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(value)) return esc(value);
  return '#';
}

/* Экранирование пользовательского текста при вставке через innerHTML */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ------------------------------------------------------------------
 *  Рендер секций
 * ------------------------------------------------------------------ */

/** Приблизительный курс TON → USD для показа рядом с ценой в TON. */
const FALLBACK_TON_USD = 3.0;
let tonUsdRate = FALLBACK_TON_USD;

function usdLabel(usd) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(usd);
}

function renderNav() {
  $('#nav').innerHTML = CONFIG.nav
    .map((i) => `<a class="nav__link" href="${safeUrl(i.href)}">${esc(i.label)}</a>`)
    .join('');

  $('#mobile-menu').innerHTML =
    CONFIG.nav.map((i) => `<a class="nav__link mobile-menu__link" href="${safeUrl(i.href)}">${esc(i.label)}</a>`).join('') +
    `<a href="#contact" class="btn btn--primary btn--block">Обсудить проект</a>` +
    `<a href="${safeUrl(CONFIG.company.telegramUrl)}" class="btn btn--tg btn--block" target="_blank" rel="noopener">Написать в Telegram</a>`;
}

function renderStats() {
  $('#stats').innerHTML = CONFIG.stats
    .map(
      (s, i) => `
      <div class="stat reveal reveal-d${(i % 4) + 1}">
        <div class="stat__value" data-count="${s.value}">${s.prefix}0${esc(s.suffix)}</div>
        <div class="stat__label">${esc(s.label)}</div>
      </div>`
    )
    .join('');
}

function renderServices() {
  $('#services-grid').innerHTML = CONFIG.services
    .map(
      (s, i) => `
      <article class="card reveal reveal-d${(i % 4) + 1} ${s.popular ? 'card--popular' : ''}">
        ${s.popular ? '<span class="card__badge">Хит</span>' : ''}
        <div class="card__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">${ICONS[s.icon] || ICONS.shield}</svg>
        </div>
        <h3 class="card__title">${esc(s.title)}</h3>
        <p class="card__tagline">${esc(s.tagline)}</p>

        <div class="price">
          <div class="price__row">
            <span class="price__ton">${s.priceTon}</span>
            <span class="price__currency">TON</span>
            ${s.oldPriceUsd ? `<span class="price__usd">${usdLabel(s.oldPriceUsd)}</span>` : ''}
          </div>
          <div class="price__approx">≈ ${usdLabel(Math.round(s.priceTon * tonUsdRate))}</div>
          <div class="price__unit">${esc(s.unit)}</div>
        </div>

        <ul class="features">
          ${s.features.map((f) => `<li>${CHECK_ICON}<span>${esc(f)}</span></li>`).join('')}
        </ul>

        <button class="btn ${s.popular ? 'btn--primary' : 'btn--ghost'} btn--block"
                data-pay="${esc(s.id)}">
          Оплатить ${s.priceTon} TON
        </button>
      </article>`
    )
    .join('');
}

const CASE_VISUALS = {
  'Fintech / TON Connect':
    '<circle cx="60" cy="60" r="34"/><path d="M60 26v68M26 60h68"/><rect x="44" y="44" width="32" height="32" rx="4"/>',
  'DeFi / Аудит':
    '<path d="M60 22l30 12v24c0 20-13 32-30 40-17-8-30-20-30-40V34l30-12z"/><path d="M48 60l9 9 17-19"/>',
  'Trading / Ликвидность':
    '<path d="M24 82l18-24 14 12 20-30"/><path d="M64 40h14v14"/><path d="M24 96h72"/>',
};

function renderCases() {
  $('#cases-list').innerHTML = CONFIG.cases
    .map(
      (c, i) => `
      <article class="case reveal reveal-d${(i % 3) + 1}">
        <div class="case__body">
          <span class="case__type">${esc(c.type)}</span>
          <h3 class="case__title">${esc(c.title)}</h3>
          <div class="case__result">${esc(c.result)}</div>
          <p class="case__text">${esc(c.text)}</p>
          <div class="case__tags">
            ${c.tags.map((t) => `<span class="case__tag">${esc(t)}</span>`).join('')}
          </div>
        </div>
        <div class="case__visual" aria-hidden="true">
          <svg viewBox="0 0 120 120">${CASE_VISUALS[c.type] || CASE_VISUALS['DeFi / Аудит']}</svg>
        </div>
      </article>`
    )
    .join('');
}

function renderTeam() {
  $('#team-grid').innerHTML = CONFIG.team
    .map(
      (m, i) => `
      <article class="member reveal reveal-d${(i % 3) + 1}">
        <div class="member__avatar" aria-hidden="true">${esc(m.name.charAt(0))}</div>
        <h3 class="member__name">${esc(m.name)}</h3>
        <div class="member__role">${esc(m.role)}</div>
        <p class="member__bio">${esc(m.bio)}</p>
      </article>`
    )
    .join('');
}

function renderReviews() {
  $('#reviews-grid').innerHTML = CONFIG.reviews
    .map(
      (r, i) => `
      <article class="review reveal reveal-d${(i % 3) + 1}">
        <div class="review__stars" aria-label="5 из 5">${STAR_ICON.repeat(5)}</div>
        <p class="review__text">«${esc(r.text)}»</p>
        <div class="review__author">
          <div class="review__avatar" aria-hidden="true">${esc(r.author.charAt(0))}</div>
          <div>
            <div class="review__name">${esc(r.author)}</div>
            <div class="review__role">${esc(r.role)}</div>
          </div>
        </div>
      </article>`
    )
    .join('');
}

function renderFaq() {
  $('#faq-list').innerHTML = CONFIG.faq
    .map(
      (f, i) => `
      <details class="faq__item reveal reveal-d${(i % 3) + 1}">
        <summary class="faq__question">
          <span>${esc(f.q)}</span>
          <svg class="faq__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </summary>
        <div class="faq__answer">${esc(f.a)}</div>
      </details>`
    )
    .join('');
}

const CONTACT_ICONS = {
  telegram:
    '<path d="M21 5 3 11.5l5 2 2 5.5 3.5-4 5 3.5L21 5z"/><path d="m8 13.5 8-6"/>',
  email: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
  phone:
    '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  wallet:
    '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><rect x="16" y="13" width="4" height="4" rx="1"/>',
};

function renderContacts() {
  const { email, phone, telegram, telegramUrl } = CONFIG.company;
  const { wallet } = CONFIG.payment;

  const rows = [
    { icon: 'telegram', label: 'Telegram', value: `@${telegram}`, href: telegramUrl },
    { icon: 'email', label: 'Email', value: email, href: `mailto:${email}` },
    { icon: 'phone', label: 'Телефон', value: phone, href: `tel:${phone.replace(/[^\d+]/g, '')}` },
    { icon: 'wallet', label: 'Кошелёк (TON)', value: `${wallet.slice(0, 8)}…${wallet.slice(-6)}`, href: null },
  ];

  $('#contact-info').innerHTML = rows
    .map((r) => {
      const inner = `
        <div class="contact-row__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">${CONTACT_ICONS[r.icon]}</svg>
        </div>
        <div>
          <div class="contact-row__label">${esc(r.label)}</div>
          <div class="contact-row__value">${esc(r.value)}</div>
        </div>`;
      return r.href
        ? `<a class="contact-row" href="${safeUrl(r.href)}" ${
            r.icon === 'telegram' ? 'target="_blank" rel="noopener"' : ''
          }>${inner}</a>`
        : `<div class="contact-row">${inner}</div>`;
    })
    .join('');

  // Опции в select формы
  $('#cf-service').innerHTML =
    '<option value="other">Другое / не знаю</option>' +
    CONFIG.services.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');

  // Футер
  $('#footer-nav').innerHTML = CONFIG.nav
    .map((i) => `<a href="${safeUrl(i.href)}">${esc(i.label)}</a>`)
    .join('');

  $('#footer-contacts').innerHTML = [
    `<a href="${safeUrl(telegramUrl)}" target="_blank" rel="noopener">Telegram</a>`,
    `<a href="${safeUrl(`mailto:${email}`)}">${esc(email)}</a>`,
    `<a href="${safeUrl(`tel:${phone.replace(/[^\d+]/g, '')}`)}">${esc(phone)}</a>`,
  ].join('');

  $('#footer-legal').textContent =
    `© ${new Date().getFullYear()} ${CONFIG.company.legalName}. ${CONFIG.company.legalAddress}. ` +
    `Сайт не является инвестиционной рекомендацией и публичным предложением криптовалюты.`;

  $('#cta-telegram').href = telegramUrl;

  const socials = [
    { label: 'Telegram', href: telegramUrl, icon: CONTACT_ICONS.telegram },
  ];
  $('#socials').innerHTML = socials
    .map(
      (s) => `<a class="footer__social" href="${esc(s.href)}" target="_blank" rel="noopener" aria-label="${esc(s.label)}"><svg viewBox="0 0 24 24">${s.icon}</svg></a>`
    )
    .join('');
}


/* ------------------------------------------------------------------
 *  Модальное окно оплаты
 * ------------------------------------------------------------------ */

let currentOrder = null;
let pollingTimer = null;

const modal = $('#pay-modal');

/** Рисуем QR-код (использует глобальную window.qrcode) */
function renderQr(text) {
  const box = $('#pay-qr');
  box.innerHTML = '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (err) {
    // Если QR не построился — не страшно, ниже есть адрес и кнопка копирования
    console.warn('QR не удалось построить:', err);
    box.style.display = 'none';
  }
}

function setStatus(type, html, icon = '') {
  const box = $('#pay-status');
  box.className = `pay-status pay-status--visible pay-status--${type}`;
  $('#pay-status-icon').innerHTML = icon;
  $('#pay-status-body').innerHTML = html;
}

function clearStatus() {
  $('#pay-status').className = 'pay-status';
  $('#pay-status-body').innerHTML = '';
}

function openPayModal(serviceId) {
  const service = CONFIG.services.find((s) => s.id === serviceId);
  if (!service) return;

  // Восстанавливаем незавершённый заказ этой услуги, если он есть
  let order = currentOrder && currentOrder.serviceId === serviceId ? currentOrder : null;
  if (!order) order = createOrder(service);

  currentOrder = order;
  clearStatus();

  $('#pay-title').textContent = service.title;
  $('#pay-subtitle').textContent = service.tagline;
  $('#pay-amount').innerHTML = `${service.priceTon}<span>TON</span>`;
  $('#pay-usd').textContent = `≈ ${usdLabel(Math.round(service.priceTon * tonUsdRate))}`;
  $('#pay-order-id').textContent = order.id;
  $('#pay-comment').textContent = order.comment;
  $('#pay-wallet').textContent = CONFIG.payment.wallet;

  const link = buildPaymentLink({
    wallet: CONFIG.payment.wallet,
    ton: service.priceTon,
    comment: order.comment,
  });
  $('#pay-open-wallet').href = link;
  renderQr(link);

  $('#pay-check').innerHTML = 'Проверить оплату';
  $('#pay-check').disabled = false;

  modal.classList.add('modal--open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#copy-wallet').focus();
}

function closePayModal() {
  modal.classList.remove('modal--open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  stopPolling();
  currentOrder = null;
}

/** Автопроверка: опрашиваем сеть, пока платёж не подтвердится или не выйдет лимит */
function startPolling(order, attemptsLeft = 20) {
  stopPolling();
  const tick = async () => {
    const result = await checkPayment(order);

    if (result.paid) {
      updateOrder(order.id, { status: 'paid', txHash: result.txHash });
      const txLink = result.txHash ? buildTxLink(result.txHash) : '';
      setStatus(
        'success',
        `<strong>Оплата получена. Спасибо!</strong>
         Начислено ${esc(result.amount)} TON.${
           txLink ? ` <a href="${txLink}" target="_blank" rel="noopener">Открыть транзакцию</a>` : ''
         }
         <br>Мы уже получили заявку и напишем в Telegram в течение 15 минут.`,
        CHECK_ICON
      );
      $('#pay-check').disabled = true;
      $('#pay-check').innerHTML = 'Оплата подтверждена';
      return;
    }

    if (result.reason === 'network') {
      setStatus(
        'error',
        `<strong>Не удалось проверить оплату</strong>
         Нет связи с сетью TON. Проверьте интернет и нажмите «Проверить оплату» ещё раз.`,
        '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
      );
      return;
    }

    // Платёж пока не найден
    const left = attemptsLeft;
    if (left <= 0) {
      setStatus(
        'error',
        `<strong>Оплата пока не обнаружена</strong>
         Если вы уже перевели, подождите до минуты и попробуйте снова. Если деньги списались,
         а заказ не появился — напишите нам: <a href="${esc(CONFIG.company.telegramUrl)}" target="_blank" rel="noopener">@${esc(CONFIG.company.telegram)}</a>.`,
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
      );
      return;
    }

    setStatus(
      'pending',
      `<strong>Проверяем оплату…</strong>
       Осталось попыток: ${left}. Обычно подтверждение занимает 10–30 секунд.`,
      '<span class="spinner" aria-hidden="true"></span>'
    );

    pollingTimer = setTimeout(tick, 6000);
  };

  tick();
}

function stopPolling() {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}


/* ------------------------------------------------------------------
 *  Баланс кошелька в hero
 * ------------------------------------------------------------------ */

async function loadWalletBalance() {
  const balanceEl = $('#wallet-balance');
  const usdEl = $('#wallet-usd');

  try {
    const raw = toRawAddress(CONFIG.payment.wallet);
    const res = await fetch(`${CONFIG.payment.verifyApi}/${raw}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const ton = Number(data.balance || 0) / 1e9;
    balanceEl.textContent = `${ton.toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })} TON`;
    usdEl.textContent = `≈ ${usdLabel(Math.round(ton * tonUsdRate))} · обновлено ${new Date(
      data.last_activity ? new Date(data.last_activity * 1000) : new Date()
    ).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    // Не страшно: сайт работает и без баланса
    balanceEl.textContent = 'TON Mainnet';
    usdEl.textContent = 'Баланс временно недоступен';
  }
}

/** Подтягиваем курс TON, чтобы показать «≈ $» рядом с ценой в крипте. */
async function loadTonRate() {
  try {
    const res = await fetch('https://tonapi.io/v2/rates?base=ton&symbols=usd');
    if (!res.ok) throw new Error('rate');
    const data = await res.json();
    const rate = Number(data?.rates?.TON?.USD ?? data?.rates?.ton?.usd);
    if (rate > 0) tonUsdRate = rate;
  } catch {
    // остаётся FALLBACK_TON_USD
  }
}

/* ------------------------------------------------------------------
 *  Анимации: появление секций и счётчики
 * ------------------------------------------------------------------ */

function initReveal() {
  const items = $$('.reveal');
  if (!items.length) return;

  if (!('IntersectionObserver' in window)) {
    items.forEach((i) => i.classList.add('reveal--visible'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal--visible');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );

  items.forEach((i) => io.observe(i));
}

function initCounters() {
  const nums = $$('[data-count]');
  if (!nums.length || !('IntersectionObserver' in window)) {
    nums.forEach((n) => (n.textContent = n.textContent));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        io.unobserve(el);

        const target = Number(el.dataset.count) || 0;
        const prefix = el.textContent.match(/^[^0-9]*/)?.[0] || '';
        const suffix = el.textContent.match(/[^0-9]*$/)?.[0] || '';
        const duration = 1200;
        const start = performance.now();

        const step = (now) => {
          const p = Math.min((now - start) / duration, 1);
          // плавное замедление к концу
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = `${prefix}${Math.round(target * eased)}${suffix}`;
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
    { threshold: 0.4 }
  );

  nums.forEach((n) => io.observe(n));
}

/** Летящие монетки на фоне hero */
function initCoins() {
  const box = $('#coins');
  if (!box) return;
  // Не нагружаем слабые устройства
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const count = window.innerWidth < 768 ? 8 : 14;
  for (let i = 0; i < count; i++) {
    const coin = document.createElement('span');
    const size = 10 + Math.random() * 26;
    coin.className = 'coin';
    coin.style.width = `${size}px`;
    coin.style.height = `${size}px`;
    coin.style.left = `${Math.random() * 100}%`;
    coin.style.animationDuration = `${14 + Math.random() * 16}s`;
    coin.style.animationDelay = `${Math.random() * 14}s`;
    box.appendChild(coin);
  }
}

/* ------------------------------------------------------------------
 *  Хедер: скролл, мобильное меню, активная ссылка
 * ------------------------------------------------------------------ */

function initHeader() {
  const header = $('#header');
  const burger = $('#burger');
  const menu = $('#mobile-menu');

  // Фон хедера появляется после скролла
  const onScroll = () => header.classList.toggle('header--scrolled', window.scrollY > 20);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Бургер
  const toggleMenu = (open) => {
    menu.classList.toggle('mobile-menu--open', open);
    burger.classList.toggle('burger--active', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  };
  burger.addEventListener('click', () =>
    toggleMenu(!menu.classList.contains('mobile-menu--open'))
  );
  // Закрываем меню при выборе пункта
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) toggleMenu(false);
  });

  // Подсветка активного раздела
  const links = $$('#nav .nav__link');
  const sections = links
    .map((l) => document.querySelector(l.getAttribute('href')))
    .filter(Boolean);

  if (sections.length && 'IntersectionObserver' in window) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((l) =>
            l.classList.toggle(
              'nav__link--active',
              l.getAttribute('href') === `#${entry.target.id}`
            )
          );
        });
      },
      { rootMargin: '-45% 0px -50% 0px' }
    );
    sections.forEach((s) => spy.observe(s));
  }
}


/* ------------------------------------------------------------------
 *  События: оплата, форма, модалка
 * ------------------------------------------------------------------ */

function initPayment() {
  // Кнопки «Оплатить» в карточках услуг
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pay]');
    if (btn) {
      e.preventDefault();
      openPayModal(btn.dataset.pay);
    }
  });

  // Закрытие модалки
  $$('[data-close-modal]').forEach((el) =>
    el.addEventListener('click', closePayModal)
  );

  // Esc закрывает модалку
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('modal--open')) {
      closePayModal();
    }
  });

  // Копирование адреса кошелька
  $('#copy-wallet').addEventListener('click', async () => {
    const btn = $('#copy-wallet');
    try {
      await navigator.clipboard.writeText(CONFIG.payment.wallet);
      btn.textContent = 'Скопировано';
      btn.classList.add('copy-btn--done');
    } catch {
      // Фолбэк для старых браузеров без Clipboard API
      const ta = document.createElement('textarea');
      ta.value = CONFIG.payment.wallet;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        btn.textContent = 'Скопировано';
        btn.classList.add('copy-btn--done');
      } catch {
        btn.textContent = 'Не удалось';
      }
      document.body.removeChild(ta);
    }
    setTimeout(() => {
      btn.textContent = 'Копировать';
      btn.classList.remove('copy-btn--done');
    }, 2000);
  });

  // Кнопка «Проверить оплату» + автопроверка каждые 6 секунд
  $('#pay-check').addEventListener('click', () => {
    if (!currentOrder) return;
    $('#pay-check').disabled = true;
    $('#pay-check').innerHTML = '<span class="spinner" aria-hidden="true"></span> Проверяем…';
    startPolling(currentOrder);
  });
}

function initForm() {
  const form = $('#contact-form');
  const success = $('#form-success');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    // Netlify Forms обрабатывает сама, но показываем подтверждение сразу
    if (!form.checkValidity()) return; // браузер сам подсветит поля
    e.preventDefault();

    const data = new FormData(form);
    // honeypot: ботов не мучаем, просто «успешно» закрываем
    if (data.get('bot-field')) {
      form.reset();
      return;
    }

    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
    })
      .catch(() => {
        /* даже если сеть моргнула — показываем успех пользователю */
      })
      .finally(() => {
        success.classList.add('form__success--visible');
        form.reset();
        setTimeout(() => success.classList.remove('form__success--visible'), 8000);
      });
  });
}

/* ------------------------------------------------------------------
 *  Инициализация
 * ------------------------------------------------------------------ */

function renderAll() {
  renderNav();
  renderStats();
  renderServices();
  renderCases();
  renderTeam();
  renderReviews();
  renderFaq();
  renderContacts();
}

async function init() {
  // 1. Сначала быстрый рендер со стандартным курсом — страница видна сразу
  renderAll();
  initHeader();
  initPayment();
  initForm();
  initReveal();
  initCounters();
  initCoins();

  // 2. Затем подтягиваем актуальный курс и баланс и перерисовываем цены
  await loadTonRate();
  renderServices();
  loadWalletBalance();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

