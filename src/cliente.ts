/**
 * Cliente fino da API v1 do Numero Virtual (https://app.numero-virtual.com/api/v1/docs).
 * Sem dependencias: so fetch. Toda resposta volta como o JSON da API, para o
 * assistente ler os campos do jeito que a documentacao descreve.
 */

export const URL_PADRAO = 'https://app.numero-virtual.com/api/v1';

export interface ConfigDoCliente {
  chave: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ErroDaApi extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    mensagem: string,
    public readonly requestId?: string,
    public readonly retryAfterS?: number,
  ) {
    super(mensagem);
  }
}

export class ClienteNumeroVirtual {
  private readonly base: string;
  private readonly chave: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: ConfigDoCliente) {
    if (!cfg.chave) throw new Error('Falta a chave de API (NUMERO_VIRTUAL_API_KEY).');
    this.chave = cfg.chave;
    this.base = (cfg.baseUrl ?? URL_PADRAO).replace(/\/+$/, '');
    // A chave vai no header: fora da propria maquina, so por https.
    if (!/^https:\/\//.test(this.base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(this.base)) {
      throw new Error(`NUMERO_VIRTUAL_API_URL precisa ser https (recebido: ${this.base}).`);
    }
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async chamar<T = unknown>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    const resp = await this.fetchImpl(`${this.base}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${this.chave}`,
        'Content-Type': 'application/json',
        'User-Agent': 'numero-virtual-mcp/0.1.0',
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resp.text();
    let json: any = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = { raw: texto }; }
    if (!resp.ok || json?.success === false) {
      const erro = json?.error ?? {};
      const retry = Number(resp.headers.get('retry-after'));
      throw new ErroDaApi(
        resp.status,
        String(erro.code ?? json?.code ?? `HTTP_${resp.status}`),
        String(erro.message ?? json?.message ?? json?.error ?? `Erro HTTP ${resp.status}`),
        json?.requestId,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    return json as T;
  }

  saldo() { return this.chamar('GET', '/balance'); }
  paises() { return this.chamar('GET', '/countries'); }
  servicos(pais?: string) {
    const q = pais ? `?country=${encodeURIComponent(pais)}` : '';
    return this.chamar('GET', `/services${q}`);
  }
  pedirNumero(p: { serviceId: number; country?: string; apiId?: number; ddd?: string }) {
    return this.chamar('POST', '/activations', p);
  }
  ativacao(id: number) { return this.chamar('GET', `/activations/${id}`); }
  cancelar(id: number) { return this.chamar('DELETE', `/activations/${id}`); }
  concluir(id: number) { return this.chamar('POST', `/activations/${id}/complete`); }
  reenviar(id: number) { return this.chamar('POST', `/activations/${id}/retry`); }

  /**
   * Servicos de um pais, enxutos: a lista completa do Brasil tem ~700 linhas
   * (~70 mil tokens), o que estoura o contexto de qualquer assistente. Aqui
   * filtra por nome/codigo e corta em `limite`, devolvendo so o que decide a
   * compra: id, nome, codigo, preco, estoque e opcoes.
   */
  async servicosResumidos(pais = 'BR', busca?: string, limite = 30) {
    const r: any = await this.servicos(pais);
    const d = r?.data ?? r;
    const todos: any[] = d?.services ?? [];
    const termo = busca?.trim().toLowerCase();
    const filtrados = termo
      ? todos.filter((s) => String(s.serviceName ?? '').toLowerCase().includes(termo) || String(s.serviceCode ?? '').toLowerCase() === termo)
      : todos;
    const ordenados = [...filtrados].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    return {
      country: d?.country ?? pais,
      countryName: d?.countryName,
      total: todos.length,
      encontrados: filtrados.length,
      mostrando: Math.min(limite, filtrados.length),
      dica: filtrados.length > limite ? `Ha mais ${filtrados.length - limite} servicos; refine com "search" ou aumente "limit".` : undefined,
      services: ordenados.slice(0, limite).map((s) => ({
        serviceId: s.serviceId,
        name: s.serviceName,
        code: s.serviceCode,
        priceCents: s.price,
        available: s.available,
        options: (s.options ?? []).map((o: any) => ({ apiId: o.apiId, name: o.name, priceCents: o.price, available: o.available })),
      })),
    };
  }

  /**
   * Espera o codigo chegar: consulta a cada `intervaloS` ate `timeoutS`.
   * Devolve a ultima resposta da ativacao, tenha chegado ou nao. Um 429 no
   * meio da espera nao derruba a ferramenta: dorme o retry-after e segue.
   */
  async esperarSms(id: number, timeoutS = 60, intervaloS = 5, dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    const limite = Date.now() + timeoutS * 1000;
    const consultar = async (): Promise<any> => {
      try {
        return await this.ativacao(id);
      } catch (e) {
        if (e instanceof ErroDaApi && e.status === 429 && Date.now() < limite) {
          await dormir(Math.min((e.retryAfterS ?? intervaloS) * 1000, Math.max(0, limite - Date.now())));
          return null;
        }
        throw e;
      }
    };
    let ultima: any = await consultar();
    while ((ultima === null || (!chegou(ultima) && !terminou(ultima))) && Date.now() < limite) {
      if (ultima !== null) await dormir(intervaloS * 1000);
      ultima = await consultar();
    }
    if (ultima === null) ultima = await this.ativacao(id);
    return { ...ultima, aguardou_s: Math.round(timeoutS - Math.max(0, limite - Date.now()) / 1000), codigo_chegou: chegou(ultima) };
  }
}

const dados = (r: any) => r?.data ?? r;
export function chegou(r: any): boolean {
  const d = dados(r);
  return Boolean(d?.smsCode) || d?.status === 'sms_received';
}
export function terminou(r: any): boolean {
  const s = dados(r)?.status;
  return s === 'cancelled' || s === 'expired' || s === 'refunded';
}
