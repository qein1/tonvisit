/**
 * ===========================================================
 *  Страница-редирект оплаты (pay-redirect.html)
 *
 *  В неё попадает посетитель при сканировании QR-кода.
 *  Задача: показать сумму и перекинуть в кошелёк по схеме ton://.
 *
 *  Почему не кладём ton:// прямо в QR: Google Объектив и часть других
 *  сканеров custom-схемы не открывают — они показывают превью, а по
 *  кнопке «Открыть» передают кошельку искажённый URI, и тот отвечает
 *  «Неверная ссылка». С https-ссылкой сканер не спорит.
 * ===========================================================
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var NANOTON = 1e9;

  /** Только разрешённые адреса: friendly-формат TON, 48 символов base64url. */
  function isValidAddress(value) {
    return typeof value === 'string' && /^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/.test(value);
  }

  /** Сумма — только положительное целое число нанотонов. */
  function parseAmount(value) {
    var nano = Number(value);
    if (!Number.isFinite(nano) || nano <= 0 || !Number.isInteger(nano)) return null;
    return nano;
  }

  /**
   * Комментарий: режем длину и убираем всё, что не ASCII-печатаемое.
   * В ton:// он попадает в query, и мусорные символы ломают разбор.
   */
  function sanitizeComment(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[^\x20-\x7E]/g, '').slice(0, 64);
  }

  function formatGram(nano) {
    var whole = Math.floor(nano / NANOTON);
    var frac = (nano % NANOTON).toString();
    while (frac.length < 9) frac = '0' + frac;
    frac = frac.replace(/0+$/, '');
    return frac ? whole + '.' + frac : String(whole);
  }

  function fail(message) {
    $('pr-title').textContent = 'Не удалось открыть платёж';
    $('pr-hint').textContent = message;
  }

  var params = new URLSearchParams(window.location.search);
  var address = params.get('address');
  var amount = parseAmount(params.get('amount'));
  var comment = sanitizeComment(params.get('text'));

  // Без валидного адреса и суммы переходить некуда — честно говорим об этом
  if (!isValidAddress(address) || amount === null) {
    fail('Ссылка повреждена. Откройте сайт заново и отсканируйте QR-код ещё раз.');
    return;
  }

  var transfer = new URLSearchParams({ address: address, amount: String(amount) });
  if (comment) transfer.set('text', comment);
  var deepLink = 'ton://transfer?' + transfer.toString();

  $('pr-sum').textContent = formatGram(amount) + ' GRAM';
  $('pr-open').href = deepLink;
  $('pr-addr').textContent = address;

  // Показываем кнопку сразу, но не мешаем автопереходу:
  // браузер может его заблокировать, и тогда спасёт нажатие руками.
  $('pr-open').hidden = false;
  $('pr-note').hidden = false;
  $('pr-addr').hidden = false;

  // Небольшая задержка: на iOS переход по custom-схеме сразу после загрузки
  // часто игнорируется, и страница остаётся белой.
  window.setTimeout(function () {
    window.location.href = deepLink;
  }, 250);
})();
