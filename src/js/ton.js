/**
 * ============================================================
 *  Модуль оплаты в TON
 *  Без зависимостей и без бэкенда.
 *
 *  Как это работает:
 *   1. Пользователь нажимает «Оплатить» — создаётся заказ с уникальным ID.
 *   2. Ссылка вида ton://transfer?text=<ID>&amount=<нанотоны>&address=<кошелёк>
 *      открывает кошелёк с уже подставленной суммой и комментарием.
 *   3. «Проверить оплату» дёргает публичный API tonapi.io и ищет входящую
 *      транзакцию на нашу сумму с нашим комментарием.
 * ============================================================
 */

import { CONFIG } from './config.js';

const NANOTON = 1e9; // 1 TON = 1_000_000_000 нанотонов
const STORAGE_KEY = 'tonvisit_orders';

/* ------------------------------------------------------------------
 *  Работа с адресами
 * ------------------------------------------------------------------ */

/** Friendly (EQ…) → raw (0:…). Нужно для публичного API tonapi.io. */
export function toRawAddress(address) {
  const addr = String(address).trim();
  if (!addr) throw new Error('Пустой адрес');
  if (addr.startsWith('0:') || addr.startsWith('-1:')) return addr;
  if (addr.startsWith('UQ')) return fromFriendly(addr, 0x51);
  return fromFriendly(addr, 0x11);
}

function fromFriendly(address, expectedTag) {
  const b64 = address.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = base64ToBytes(b64);
  if (bytes.length !== 36) throw new Error('Некорректный адрес кошелька');
  const tag = bytes[0];
  // 0x11/0x51 — mainnet, +0x80 (0x91/0xD1) — testnet
  if (tag !== expectedTag && tag !== expectedTag + 0x80) {
    throw new Error('Адрес не в сети TON (mainnet)');
  }
  const workchain = bytes[1] === 0xff ? '-1' : '0';
  return `${workchain}:${bytesToHex(bytes.slice(2, 34))}`;
}

function base64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Сумма в TON → нанотоны (целое, без плавающей точки — как требует сеть). */
export function toNano(ton) {
  return BigInt(Math.round(Number(ton) * NANOTON));
}

/** Нанотоны → строка вида «4.5». */
export function formatNano(nano) {
  const n = BigInt(nano);
  const whole = n / BigInt(NANOTON);
  const frac = (n % BigInt(NANOTON)).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/* ------------------------------------------------------------------
 *  Ссылки на оплату
 * ------------------------------------------------------------------ */

/**
 * Deep-link для кошелька. Поддерживается Tonkeeper, Telegram Wallet,
 * Tonhub, MyTonWallet и другими.
 */
export function buildPaymentLink({ wallet, ton, comment }) {
  const params = new URLSearchParams({
    text: comment,
    amount: toNano(ton).toString(),
    address: wallet,
  });
  return `ton://transfer?${params.toString()}`;
}

/** Ссылка на кошелёк, чтобы просто открыть приложение. */
export function buildWalletLink(wallet) {
  return `ton://wallet?${new URLSearchParams({ address: wallet }).toString()}`;
}

/** Ссылка на транзакцию в обозревателе. */
export function buildTxLink(hash) {
  return `${CONFIG.payment.explorer}/transaction/${hash}`;
}

/* ------------------------------------------------------------------
 *  Заказы
 * ------------------------------------------------------------------ */

function randomId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .slice(0, 7);
}

/** Создаёт заказ и сохраняет его в localStorage. */
export function createOrder(service) {
  const order = {
    id: `TV-${randomId()}`,
    serviceId: service.id,
    title: service.title,
    ton: service.priceTon,
    // Комментарий в блокчейне: id заказа + id услуги.
    // Держим коротким и ASCII — так он надёжнее отображается в кошельках.
    comment: '',
    createdAt: Date.now(),
    status: 'pending', // pending | paid
    txHash: '',
  };
  order.comment = `${order.id}-${service.id}`.slice(0, 36);
  saveOrder(order);
  return order;
}

function readOrders() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveOrder(order) {
  const orders = readOrders().filter((o) => o.id !== order.id);
  orders.unshift(order);
  // Храним максимум 20 последних заказов
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders.slice(0, 20)));
  } catch {
    /* приватный режим браузера — просто пропускаем */
  }
}

export function getOrder(id) {
  return readOrders().find((o) => o.id === id) || null;
}

export function getOrders() {
  return readOrders();
}

export function updateOrder(id, patch) {
  const order = getOrder(id);
  if (!order) return null;
  const next = { ...order, ...patch };
  saveOrder(next);
  return next;
}

/* ------------------------------------------------------------------
 *  Проверка оплаты в сети TON
 * ------------------------------------------------------------------ */

/**
 * Ищем входящую транзакцию: сумма >= ожидаемой и комментарий совпадает.
 * Возвращает { paid, txHash, reason, error }.
 */
export async function checkPayment(order, { signal } = {}) {
  const { wallet, verifyApi } = CONFIG.payment;
  const expected = toNano(order.ton);
  const rawWallet = toRawAddress(wallet);

  let events;
  try {
    const res = await fetch(`${verifyApi}/${rawWallet}/events?limit=50`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    events = data.events || [];
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return {
      paid: false,
      txHash: '',
      reason: 'network',
      error: err.message || 'Не удалось связаться с сетью TON',
    };
  }

  const comment = String(order.comment).trim().toLowerCase();
  // Допуск: платёж считаем нашим, только если он не старше суток
  const createdWithSkew = Math.floor(order.createdAt / 1000) - 3600;

  for (const event of events) {
    if (event.timestamp < createdWithSkew) continue;

    for (const action of event.actions || []) {
      const transfer = action.TonTransfer || action.JettonTransfer || action.TokenTransfer;
      if (!transfer) continue;

      // Получатель должен совпадать с нашим кошельком
      const recipient = (transfer.recipient || transfer.recipients_wallet || {}).address;
      if (recipient !== rawWallet) continue;

      const amount = BigInt(transfer.amount || '0');
      if (amount < expected) continue;

      // Комментарий: если кошелёк его прислал — обязан совпасть.
      // Некоторые кошельки обрезают комментарий, тогда сверяем только сумму.
      const txComment = String(transfer.comment || '')
        .trim()
        .toLowerCase();
      if (txComment && txComment !== comment) continue;

      return {
        paid: true,
        txHash: event.event_id || '',
        amount: formatNano(amount),
        commentMatched: Boolean(txComment),
      };
    }
  }

  return { paid: false, txHash: '', reason: 'not_found' };
}

