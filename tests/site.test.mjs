/**
 * Интеграционный тест сайта TONVISIT в jsdom:
 * рендер секций, модалка оплаты, QR, deep-link, автопроверка платежа.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Корень проекта = родительская папка tests/
const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(`${SITE}/index.html`, 'utf8');
const qrLib = readFileSync(`${SITE}/src/js/qrcode-generator.js`, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.netlify.app/', pretendToBeVisual: true });
const { window } = dom;

window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
}));
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { this.cb([{ isIntersecting: true, target: el }], this); }
  unobserve() {} disconnect() {}
};
if (!window.crypto || !window.crypto.getRandomValues) {
  window.crypto = { getRandomValues: (arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    return arr;
  } };
}
// ton.js исполняется в контексте Node, а main.js — в контексте окна,
// поэтому мок fetch ставим в оба места.
let fetchCalls = [];
let fetchHandler = async () => ({
  ok: true, status: 200,
  json: async () => ({ balance: '12345000000', last_activity: Math.floor(Date.now() / 1000) }),
});
globalThis.fetch = (url, opts) => { fetchCalls.push(String(url)); return fetchHandler(url, opts); };
window.fetch = (url, opts) => { fetchCalls.push(String(url)); return fetchHandler(url, opts); };

window.eval(qrLib);
ok(typeof window.qrcode === 'function', 'QR-библиотека доступна как глобальная функция');

const toUrl = (p) => pathToFileURL(`${SITE}/${p}`).href;
const cfgMod = await import(toUrl('src/js/config.js'));
const tonMod = await import(toUrl('src/js/ton.js'));

// Выполняем main.js в контексте окна, подменив модульные импорты
const mainSrc = readFileSync(`${SITE}/src/js/main.js`, 'utf8')
  .replace(/import\s*\{\s*CONFIG\s*\}\s*from\s*'[^']+';/, 'const CONFIG = window.__CONFIG;')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']*ton\.js';/,
    ['createOrder','buildPaymentLink','buildWalletLink','buildTxLink','checkPayment','toRawAddress','updateOrder']
      .map((n) => `const ${n} = window.__ton.${n};`).join('\n'));

window.__CONFIG = cfgMod.CONFIG;
window.__ton = tonMod;
window.eval(mainSrc);

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => Array.from(window.document.querySelectorAll(s));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[1a] Возврат наверх при перезагрузке');
// Скрипт подключён синхронно в <head> — иначе браузер успеет восстановить скролл
const headScripts = $$('head script[src]').map((s) => s.getAttribute('src'));
ok(headScripts.includes('/src/js/scroll-top.js'), 'scroll-top.js подключён в <head>');
ok(
  !/defer|async/i.test($('head script[src="/src/js/scroll-top.js"]')?.outerHTML || ''),
  'Скрипт без defer/async — иначе он запустится поздно'
);
ok(
  $$('head script:not([src])').every((s) => (s.type || '') === 'application/ld+json'),
  "В <head> нет inline-скриптов: CSP со script-src 'self' их бы заблокировал"
);

// Проверяем сам скрипт на изолированных документах с разным состоянием адреса
const runScrollTop = (url) => {
  const d = new JSDOM('<p>x</p>', { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const calls = [];
  d.window.scrollTo = (arg) => calls.push(arg);
  d.window.history.scrollRestoration = 'auto';
  d.window.eval(readFileSync(`${SITE}/src/js/scroll-top.js`, 'utf8'));
  return { window: d.window, calls };
};

const plain = runScrollTop('https://example.netlify.app/');
ok(plain.window.history.scrollRestoration === 'manual', 'Восстановление позиции скролла отключено');
ok(plain.calls.length > 0, 'Страница без якоря прокручивается наверх');

const withHash = runScrollTop('https://example.netlify.app/#faq');
ok(withHash.calls.length === 0, 'Прямая ссылка с якорем не перебивается — скролл не трогаем');
// scrollRestoration = 'manual' и здесь: переход по якорю — это fragment navigation,
// он выполняется браузером независимо от scrollRestoration, поэтому direct-links работают.
// А вот возвращаться к прошлой позиции при F5 по такой ссылке смысла нет.
ok(
  withHash.window.history.scrollRestoration === 'manual',
  'И при прямой ссылке восстановление позиции отключено (якорь и так отработает)'
);

console.log('\n[1] Рендер секций');
ok($$('#nav .nav__link').length === cfgMod.CONFIG.nav.length, 'Навигация отрисована');
ok($$('#stats .stat').length === cfgMod.CONFIG.stats.length, 'Статистика отрисована');
ok($$('#services-grid .card').length === cfgMod.CONFIG.services.length, 'Карточки услуг отрисованы');
ok($$('#cases-list .case').length === cfgMod.CONFIG.cases.length, 'Кейсы отрисованы');
ok($$('#team-grid .member').length === cfgMod.CONFIG.team.length, 'Команда отрисована');
ok($$('#reviews-grid .review').length === cfgMod.CONFIG.reviews.length, 'Отзывы отрисованы');
ok($$('#faq-list .faq__item').length === cfgMod.CONFIG.faq.length, 'FAQ отрисован');
ok(
  $$('#expertise-grid .exp-card').length === cfgMod.CONFIG.expertise.length,
  'Карточки компетенций отрисованы'
);
ok(
  $$('#process-grid .process__step').length === cfgMod.CONFIG.process.length,
  'Этапы работы отрисованы'
);
ok($('#contact-info') === null, 'Блок контактов (tg/email/телефон/кошелёк) удалён');
ok($('#cf-service') === null, 'Select «Что интересует» удалён из формы');

console.log('\n[1b] Секция «Что мы делаем» (без цен)');
const expertiseText = $('#expertise-grid').textContent;
ok(
  $$('#expertise-grid .exp-card h3').length === cfgMod.CONFIG.expertise.length &&
    expertiseText.length > 200,
  'Компетенции содержат описания'
);
ok(
  // Ни блока цены, ни кнопки оплаты, ни суммы с валютой внутри одного пункта
  $$('#expertise-grid .exp-card').every(
    (c) =>
      !c.querySelector('.price') &&
      !c.querySelector('[data-pay]') &&
      Array.from(c.querySelectorAll('.exp-card__title, .exp-card__text, .exp-card__points li')).every(
        (el) => !/(?:^|\s)\d+(?:[.,]\d+)?\s*(?:TON|USDT|USD)\b|\$\s*\d/i.test(el.textContent)
      )
  ),
  'В блоке компетенций нет цен и кнопок оплаты'
);
ok(
  $$('#expertise-grid .exp-card__icon svg').length === cfgMod.CONFIG.expertise.length,
  'У каждой компетенции своя иконка'
);
ok(
  $$('#process-grid .process__step .process__num').length === cfgMod.CONFIG.process.length &&
    $('#process-grid .process__step .process__num').textContent === cfgMod.CONFIG.process[0].step,
  'Этапы пронумерованы'
);
ok(
  cfgMod.CONFIG.expertise.every((e) => e.points && e.points.length >= 1),
  'У каждой компетенции есть конкретика в пунктах'
);
ok(
  cfgMod.CONFIG.nav.some((n) => n.href === '#expertise') && !!$('#expertise'),
  'Секция «Что мы делаем» доступна из навигации'
);

console.log('\n[1c] Якоря: перезагрузка не должна прыгать к блоку «Заявка»');
// jsdom не умеет реально скроллить — считаем вызовы scrollTo
let scrollCalls = [];
window.scrollTo = (arg) => { scrollCalls.push(arg); };
// getBoundingClientRect в jsdom всегда 0 — подменяем у нужной секции
const contactRect = { top: 2400, bottom: 3200, left: 0, right: 0, width: 0, height: 800 };
$('#contact').getBoundingClientRect = () => contactRect;

const contactLink = $$('a[href="#contact"]')[0];
ok(!!contactLink, 'Ссылка на блок «Заявка» есть в разметке');
contactLink.click();
await wait(20);
ok(scrollCalls.length === 1, 'Клик по «Заявке» прокручивает страницу');
ok(
  scrollCalls[0] && Math.abs(scrollCalls[0].top - (2400 - ($('#header').offsetHeight || 0) - 16)) < 1,
  'Прокрутка с учётом высоты фиксированного хедера',
  JSON.stringify(scrollCalls[0])
);
ok(
  window.location.hash === '' && !window.location.href.includes('#contact'),
  `После клика якорь убран из адреса (был: "${window.location.hash}")`
);
ok(
  $('#contact').hasAttribute('tabindex') && window.document.activeElement === $('#contact'),
  'Фокус передан на секцию — Tab продолжает по странице'
);
// Кнопка оплаты использует href="#" и должна остаться нетронутой
const payBtn = $('#pay-open-wallet');
ok(payBtn.getAttribute('href') !== null, 'Кнопка оплаты сохраняет свой href');
const beforePay = scrollCalls.length;
payBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
ok(scrollCalls.length === beforePay, 'Служебная ссылка href="#" не вызывает прокрутку');

console.log('\n[2] Данные в карточках');
const firstCard = $('#services-grid .card');
ok(firstCard.textContent.includes(cfgMod.CONFIG.services[0].title), 'Название услуги в карточке');
ok(firstCard.textContent.includes('4.5'), 'Цена в TON в карточке');
ok(!!firstCard.querySelector('[data-pay]'), 'Кнопка оплаты с data-pay');
ok($('.card__badge') !== null, 'Бейдж «Хит» на популярном тарифе');
ok($('#footer-legal').textContent.includes(String(new Date().getFullYear())), 'Год в футере');

console.log('\n[3] Открытие модалки оплаты');
$('[data-pay]').click();
await wait(60);
ok($('#pay-modal').classList.contains('modal--open'), 'Модалка открылась');
ok($('#pay-amount').textContent.includes('4.5'), 'В модалке указана сумма');
const orderId = $('#pay-order-id').textContent;
ok(/^TV-[A-Z0-9]+$/.test(orderId), `Номер заказа корректен (${orderId})`);
ok($('#pay-comment').textContent === orderId + '-audit', 'Комментарий = id заказа + услуга');
ok($('#pay-wallet').textContent === cfgMod.CONFIG.payment.wallet, 'Адрес кошелька в модалке');
ok($('#pay-qr').innerHTML.includes('<svg'), 'QR-код отрисован как SVG');

console.log('\n[4] Deep-link оплаты');
const href = $('#pay-open-wallet').getAttribute('href');
ok(href.startsWith('ton://transfer?'), 'Ссылка ведёт на ton://transfer');
const params = new URLSearchParams(href.split('?')[1]);
ok(params.get('amount') === '4500000000', 'Сумма в нанотонах (4.5 TON = 4500000000)');
ok(params.get('address') === cfgMod.CONFIG.payment.wallet, 'Адрес получателя в ссылке');
ok(params.get('text') === orderId + '-audit', 'Комментарий в ссылке');

console.log('\n[5] Копирование адреса');
let copied = null;
window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
$('#copy-wallet').click();
await wait(40);
ok(copied === cfgMod.CONFIG.payment.wallet, 'Адрес скопирован в буфер');
ok($('#copy-wallet').textContent === 'Скопировано', 'Кнопка показала подтверждение');

console.log('\n[6] Проверка оплаты (платёж найден)');
const rawWallet = tonMod.toRawAddress(cfgMod.CONFIG.payment.wallet);
fetchHandler = async () => ({
  ok: true, status: 200,
  json: async () => ({
    events: [{
      event_id: 'abc123hash',
      timestamp: Math.floor(Date.now() / 1000),
      actions: [{
        type: 'TonTransfer',
        TonTransfer: {
          recipient: { address: rawWallet },
          amount: '4500000000',
          comment: orderId + '-audit',
        },
      }],
    }],
  }),
});
$('#pay-check').click();
await wait(150);
ok(fetchCalls.some((u) => u.includes(`${rawWallet}/events`)), 'Запрос к tonapi.io по raw-адресу');
ok($('#pay-status').className.includes('pay-status--success'), 'Статус: оплата подтверждена');
ok($('#pay-status-body').textContent.includes('Оплата получена'), 'Показано сообщение об успешной оплате');
ok($('#pay-status-body').innerHTML.includes('tonviewer.com/transaction/abc123hash'), 'Есть ссылка на транзакцию');
ok($('#pay-check').textContent.includes('подтверждена'), 'Кнопка заблокирована после оплаты');

console.log('\n[7] Проверка оплаты (платёж не найден)');
$('#pay-modal').classList.remove('modal--open');
$('[data-pay]').click();
await wait(60);
fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({ events: [] }) });
$('#pay-check').click();
await wait(120);
ok($('#pay-status').className.includes('pay-status--pending'), 'Статус: проверяем (ожидание)');
ok($('#pay-status-body').textContent.includes('Проверяем оплату'), 'Показано ожидание оплаты');

console.log('\n[8] Ошибка сети при проверке');
$('#pay-modal').classList.remove('modal--open');
$('[data-pay]').click();
await wait(60);
fetchHandler = async () => ({ ok: false, status: 500, json: async () => ({}) });
$('#pay-check').click();
await wait(120);
ok($('#pay-status').className.includes('pay-status--error'), 'Статус: ошибка сети обработана');
ok($('#pay-status-body').textContent.includes('Не удалось проверить'), 'Понятное сообщение об ошибке');

console.log('\n[9] Баланс кошелька в hero');
$('#pay-modal').classList.remove('modal--open');
fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({ balance: '12345000000', last_activity: Math.floor(Date.now() / 1000) }) });
await wait(250);
ok($('#wallet-balance').textContent.includes('TON'), 'Баланс отображён: ' + $('#wallet-balance').textContent);

console.log('\n[10] Мобильное меню, FAQ, безопасность');
$('#burger').click();
ok($('#mobile-menu').classList.contains('mobile-menu--open'), 'Бургер открывает меню');
ok($('#burger').getAttribute('aria-expanded') === 'true', 'aria-expanded обновлён');
ok($('#faq-list .faq__item').tagName === 'DETAILS', 'FAQ на <details> (работает без JS)');
// XSS-проверка: данные из конфига не должны исполняться
const xssPayload = '"><img src=x onerror="window.__xss=1">';
cfgMod.CONFIG.company.telegram = xssPayload;
cfgMod.CONFIG.company.telegramUrl = 'javascript:window.__xss2=1';
window.eval('renderContacts()');
await wait(30);
ok(window.__xss === undefined, 'Инъекция в ник не исполняется');
ok(window.__xss2 === undefined, 'Ссылка javascript: блокируется (safeUrl)');
ok($('#footer-contacts').querySelectorAll('img').length === 0, 'HTML из конфига не превращается в элементы');
ok($('#footer-contacts').textContent.includes('<img'), 'Полезный текст сохранён как текст');
const footerLinks = $$('#footer-contacts a');
ok(footerLinks.length === 1, 'В футере одна ссылка — только Telegram');
ok(
  Array.from(footerLinks).every((a) => a.attributes.length === (a.getAttribute('target') ? 3 : 1)),
  'В ссылки не попали лишние атрибуты (нет внедрения через href)'
);
ok(
  Array.from($('#footer-contacts').querySelectorAll('*')).every((el) => !el.hasAttribute('onerror')),
  'Ни у одного элемента нет обработчика onerror'
);
cfgMod.CONFIG.company.telegram = 'qeinq';
cfgMod.CONFIG.company.telegramUrl = 'https://t.me/qeinq';
window.eval('renderContacts()');
ok($('#footer-contacts').textContent.includes('@qeinq'), 'В футере указан Telegram @qeinq');
ok(!/mailto:|tel:/i.test($('footer').innerHTML), 'В футере нет email и телефона');

console.log('\n[11] Заявка уходит в Telegram');
const tgCfg = cfgMod.CONFIG.company;
let openedUrl = null;
window.open = (url) => { openedUrl = String(url); return {}; };
let formText = null;
window.navigator.clipboard = { writeText: async (t) => { formText = t; } };

// Пустая форма — отправка блокируется, поля подсвечиваются
$('#contact-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(30);
ok(openedUrl === null, 'Пустая форма не отправляется');
ok($('#cf-name').closest('.field').classList.contains('field--error'), 'Пустое поле подсвечено');

// Нормализация ника: без @ и со ссылкой
window.eval('normalizeTg("qeinq")');
ok(window.normalizeTg('qeinq') === '@qeinq', 'Ник без @ нормализуется');
ok(window.normalizeTg('t.me/qeinq') === '@qeinq', 'Ссылка t.me нормализуется');
ok(window.normalizeTg('https://t.me/qeinq') === '@qeinq', 'Полная ссылка нормализуется');
ok(window.normalizeTg('@qeinq') === '@qeinq', 'Ник с @ не меняется');

$('#cf-name').value = 'Алексей';
$('#cf-contact').value = 'qeinq';
$('#cf-message').value = 'Нужен аудит смарт-контракта';
$('#contact-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(60);
ok(openedUrl === tgCfg.telegramUrl, `Открыт Telegram ${tgCfg.telegramUrl} (${openedUrl})`);
ok(!!formText && formText.includes('Алексей'), 'В заявку попало имя');
ok(!!formText && formText.includes('@qeinq'), 'Ник нормализован в тексте заявки');
ok(!!formText && formText.includes('аудит смарт-контракта'), 'Текст задачи в заявке');
ok($('#form-success').classList.contains('form__success--visible'), 'Показано подтверждение');
ok($('#cf-name').value === '' && $('#cf-message').value === '', 'Форма очищена после отправки');
ok($('#cf-submit').disabled === false && $('#cf-submit').textContent.includes('Отправить в Telegram'), 'Кнопка вернулась в исходное состояние');

// Honeypot: бот не проходит
openedUrl = null;
$('#cf-name').value = 'Бот';
$('#cf-contact').value = 'bot';
$('#cf-message').value = 'Спам';
$('#contact-form').elements['bot-field'].value = 'spam';
$('#contact-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(30);
ok(openedUrl === null, 'Honeypot блокирует ботов');
$('#contact-form').elements['bot-field'].value = '';

console.log('\n' + '='.repeat(46));
console.log(`  Пройдено: ${pass}   Провалено: ${fail}`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);

