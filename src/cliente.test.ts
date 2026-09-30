import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClienteNumeroVirtual, ErroDaApi, chegou, terminou } from './cliente.js';

const respostas = (lista: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) => {
  const chamadas: Array<{ url: string; init: any }> = [];
  const f = (async (url: string, init: any) => {
    chamadas.push({ url, init });
    const r = lista.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, chamadas };
};

test('manda a chave no header e devolve o JSON da API', async () => {
  const { f, chamadas } = respostas([{ body: { success: true, data: { balance: 12.5 } } }]);
  const c = new ClienteNumeroVirtual({ chave: 'nv_live_x', fetchImpl: f });
  const r: any = await c.saldo();
  assert.equal(r.data.balance, 12.5);
  assert.equal(chamadas[0].url, 'https://app.numero-virtual.com/api/v1/balance');
  assert.equal(chamadas[0].init.headers.Authorization, 'Bearer nv_live_x');
});

test('erro da API vira ErroDaApi com codigo, mensagem e retry-after', async () => {
  const { f } = respostas([{ status: 429, body: { success: false, error: { code: 'CATALOG_RATE_LIMIT', message: 'Muitas consultas' }, requestId: 'r1' }, headers: { 'retry-after': '30' } }]);
  const c = new ClienteNumeroVirtual({ chave: 'k', fetchImpl: f });
  await assert.rejects(c.paises(), (e: any) => e instanceof ErroDaApi && e.codigo === 'CATALOG_RATE_LIMIT' && e.retryAfterS === 30 && e.requestId === 'r1');
});

test('sem chave nao instancia', () => {
  assert.throws(() => new ClienteNumeroVirtual({ chave: '' }), /NUMERO_VIRTUAL_API_KEY/);
});

test('esperarSms consulta ate o codigo chegar', async () => {
  const { f, chamadas } = respostas([
    { body: { success: true, data: { id: 1, status: 'waiting_sms', smsCode: null } } },
    { body: { success: true, data: { id: 1, status: 'waiting_sms', smsCode: null } } },
    { body: { success: true, data: { id: 1, status: 'sms_received', smsCode: '4321' } } },
  ]);
  const c = new ClienteNumeroVirtual({ chave: 'k', fetchImpl: f });
  const r: any = await c.esperarSms(1, 60, 1, async () => {});
  assert.equal(chamadas.length, 3);
  assert.equal(r.codigo_chegou, true);
  assert.equal(r.data.smsCode, '4321');
});

test('esperarSms para quando a ativacao termina sem codigo', async () => {
  const { f, chamadas } = respostas([{ body: { success: true, data: { id: 2, status: 'cancelled' } } }]);
  const c = new ClienteNumeroVirtual({ chave: 'k', fetchImpl: f });
  const r: any = await c.esperarSms(2, 60, 1, async () => {});
  assert.equal(chamadas.length, 1);
  assert.equal(r.codigo_chegou, false);
});

test('chegou/terminou leem data ou raiz', () => {
  assert.equal(chegou({ data: { smsCode: '1' } }), true);
  assert.equal(chegou({ status: 'sms_received' }), true);
  assert.equal(chegou({ data: { status: 'waiting_sms' } }), false);
  assert.equal(terminou({ data: { status: 'expired' } }), true);
});

test('recusa http fora da propria maquina; aceita https e localhost', () => {
  assert.throws(() => new ClienteNumeroVirtual({ chave: 'k', baseUrl: 'http://exemplo.com/api/v1' }), /https/);
  new ClienteNumeroVirtual({ chave: 'k', baseUrl: 'http://127.0.0.1:3001/api/v1' });
  new ClienteNumeroVirtual({ chave: 'k', baseUrl: 'https://app.numero-virtual.com/api/v1' });
});

test('servicosResumidos filtra por nome, ordena por preco e corta', async () => {
  const services = [
    { serviceId: 1, serviceName: 'WhatsApp', serviceCode: 'wa', price: 300, available: 5, options: [{ apiId: 1, name: 'Opção 1', price: 300, available: 5 }], priceFormatted: 'x', countryId: 24 },
    { serviceId: 2, serviceName: 'WhatsApp Business', serviceCode: 'wb', price: 250, available: 9, options: [] },
    { serviceId: 3, serviceName: 'Telegram', serviceCode: 'tg', price: 100, available: 1, options: [] },
  ];
  const { f } = respostas([{ body: { success: true, data: { country: 'BR', countryName: 'Brasil', services } } }]);
  const c = new ClienteNumeroVirtual({ chave: 'k', fetchImpl: f });
  const r: any = await c.servicosResumidos('BR', 'whats', 1);
  assert.equal(r.total, 3);
  assert.equal(r.encontrados, 2);
  assert.equal(r.mostrando, 1);
  assert.equal(r.services[0].serviceId, 2); // o mais barato dos dois
  assert.deepEqual(Object.keys(r.services[0]), ['serviceId', 'name', 'code', 'priceCents', 'available', 'options']);
  assert.match(r.dica, /mais 1/);
});

test('esperarSms sobrevive a um 429 no meio e continua', async () => {
  const { f, chamadas } = respostas([
    { body: { success: true, data: { id: 1, status: 'waiting_sms' } } },
    { status: 429, body: { success: false, error: { code: 'RATE_LIMIT', message: 'calma' } }, headers: { 'retry-after': '1' } },
    { body: { success: true, data: { id: 1, status: 'sms_received', smsCode: '777' } } },
  ]);
  const c = new ClienteNumeroVirtual({ chave: 'k', fetchImpl: f });
  const r: any = await c.esperarSms(1, 60, 1, async () => {});
  assert.equal(chamadas.length, 3);
  assert.equal(r.data.smsCode, '777');
});
