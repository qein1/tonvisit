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

console.log('\n[1] Рендер секций');
ok($$('#nav .nav__link').length === cfgMod.CONFIG.nav.length, 'Навигация отрисована');
ok($$('#stats .stat').length === cfgMod.CONFIG.stats.length, 'Статистика отрисована');
ok($$('#services-grid .card').length === cfgMod.CONFIG.services.length, 'Карточки услуг отрисованы');
ok($$('#cases-list .case').length === cfgMod.CONFIG.cases.length, 'Кейсы отрисованы');
ok($$('#team-grid .member').length === cfgMod.CONFIG.team.length, 'Команда отрисована');
ok($$('#reviews-grid .review').length === cfgMod.CONFIG.reviews.length, 'Отзывы отрисованы');
ok($$('#faq-list .faq__item').length === cfgMod.CONFIG.faq.length, 'FAQ отрисован');
ok($$('#contact-info .contact-row').length === 4, 'Контакты отрисованы (4 строки)');
ok($$('#cf-service option').length === cfgMod.CONFIG.services.length + 1, 'Опции формы заполнены');

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
cfgMod.CONFIG.company.email = xssPayload;
cfgMod.CONFIG.company.telegramUrl = 'javascript:window.__xss2=1';
window.eval('renderContacts()');
await wait(30);
ok(window.__xss === undefined, 'Инъекция в email не исполняется');
ok(window.__xss2 === undefined, 'Ссылка javascript: блокируется (safeUrl)');
ok($('#footer-contacts').querySelectorAll('img').length === 0, 'HTML из конфига не превращается в элементы');
ok($('#footer-contacts').textContent.includes('<img'), 'Полезный текст сохранён как текст');
const footerLinks = $$('#footer-contacts a');
ok(footerLinks.length === 3, 'В футере ровно 3 ссылки (структура не сломана)');
ok(
  Array.from(footerLinks).every((a) => a.attributes.length === (a.getAttribute('target') ? 3 : 1)),
  'В ссылки не попали лишние атрибуты (нет внедрения через href)'
);
ok(
  Array.from($('#footer-contacts').querySelectorAll('*')).every((el) => !el.hasAttribute('onerror')),
  'Ни у одного элемента нет обработчика onerror'
);
cfgMod.CONFIG.company.email = 'hello@tonvisit.io';
cfgMod.CONFIG.company.telegramUrl = 'https://t.me/tonvisit_support';
window.eval('renderContacts()');

console.log('\n' + '='.repeat(46));
console.log(`  Пройдено: ${pass}   Провалено: ${fail}`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);

