#!/usr/bin/env node
/**
 * numero-virtual-mcp: servidor MCP (stdio) do Numero Virtual.
 *
 * Deixa um assistente (Claude Desktop, Claude Code, Cursor, OpenClaw...) pedir
 * um numero virtual, esperar o codigo de verificacao chegar e encerrar ou
 * cancelar, com a chave de API do proprio cliente (nv_live_...), gerada no
 * painel em app.numero-virtual.com > Desenvolvedores.
 *
 * Por baixo e a API v1 publica (https://app.numero-virtual.com/api/v1/docs);
 * cada ferramenta e uma chamada, e a resposta volta como a API devolve.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ClienteNumeroVirtual, ErroDaApi, URL_PADRAO } from './cliente.js';

const chave = process.env.NUMERO_VIRTUAL_API_KEY ?? '';
const baseUrl = process.env.NUMERO_VIRTUAL_API_URL || URL_PADRAO;

if (!chave) {
  console.error('numero-virtual-mcp: defina NUMERO_VIRTUAL_API_KEY (chave nv_live_... do painel > Desenvolvedores).');
  process.exit(1);
}

const api = new ClienteNumeroVirtual({ chave, baseUrl });

const server = new McpServer({ name: 'numero-virtual', version: '0.1.0' });

type Resultado = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const texto = (v: unknown): Resultado => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

/** Toda ferramenta passa por aqui: erro da API vira texto claro, nao excecao. */
async function executar(fn: () => Promise<unknown>): Promise<Resultado> {
  try {
    return texto(await fn());
  } catch (e) {
    if (e instanceof ErroDaApi) {
      const dica = e.retryAfterS ? ` Tente de novo em ${e.retryAfterS} s.` : '';
      return { isError: true, content: [{ type: 'text', text: `Erro ${e.codigo} (HTTP ${e.status}): ${e.message.replace(/\.$/, '')}.${dica}${e.requestId ? ` [requestId ${e.requestId}]` : ''}` }] };
    }
    return { isError: true, content: [{ type: 'text', text: `Falha: ${(e as Error).message}` }] };
  }
}

server.registerTool('get_balance', {
  title: 'Saldo da conta',
  description: 'Saldo atual da conta no Numero Virtual, em reais (BRL). Toda compra de numero desconta daqui.',
  inputSchema: {},
}, async () => executar(() => api.saldo()));

server.registerTool('list_countries', {
  title: 'Paises disponiveis',
  description: 'Lista os paises com numeros em estoque e quantos servicos cada um tem. Use o campo "code" (ISO, ex.: BR, US) nas outras ferramentas. Limite: 6 consultas por minuto; o resultado muda pouco, entao guarde-o.',
  inputSchema: {},
}, async () => executar(() => api.paises()));

server.registerTool('list_services', {
  title: 'Servicos e precos de um pais',
  description: 'Servicos (WhatsApp, Telegram, Google...) com estoque em um pais, do mais barato ao mais caro, com preco em centavos de BRL e as opcoes (fornecedores) de cada um. O "serviceId" e o "apiId" daqui sao os que vao em request_number. Use "search" para achar um servico pelo nome (a lista completa do Brasil tem ~700 itens). Limite: 6 consultas por minuto.',
  inputSchema: {
    country: z.string().min(2).max(50).default('BR').describe('Codigo ISO do pais (BR, US, ID...), slug ou nome. Padrao: BR.'),
    search: z.string().min(1).max(60).optional().describe('Trecho do nome do servico (ex.: "whats", "telegram") ou o codigo exato (ex.: "wa").'),
    limit: z.number().int().min(1).max(200).default(30).describe('Quantos servicos devolver. Padrao 30.'),
  },
}, async ({ country, search, limit }) => executar(() => api.servicosResumidos(country, search, limit)));

server.registerTool('request_number', {
  title: 'Pedir um numero',
  description: 'Compra um numero virtual para receber o SMS de verificacao de um servico. Debita o saldo na hora. Devolve o id da ativacao e o telefone; depois use wait_for_sms (ou get_activation) para ler o codigo. O numero vale ~20 minutos; se o SMS nao vier, cancele com cancel_activation para o valor voltar ao saldo.',
  inputSchema: {
    serviceId: z.number().int().positive().describe('ID do servico, de list_services.'),
    country: z.string().min(2).max(50).default('BR').describe('Codigo ISO do pais. Padrao: BR.'),
    apiId: z.number().int().positive().optional().describe('Opcao (fornecedor) especifica, de list_services. Sem isso a API escolhe a mais barata com estoque.'),
    ddd: z.string().regex(/^\d{2}$/).optional().describe('Somente Brasil: DDD de 2 digitos desejado. Pode ter taxa adicional.'),
  },
}, async (p) => executar(() => api.pedirNumero(p)));

server.registerTool('get_activation', {
  title: 'Consultar ativacao',
  description: 'Situacao atual de uma ativacao: status (waiting_sms, sms_received, cancelled, expired), telefone, codigo e texto do SMS quando ja chegou. Consulte a cada 5-10 s; prefira wait_for_sms.',
  inputSchema: { id: z.number().int().positive().describe('ID da ativacao, de request_number.') },
}, async ({ id }) => executar(() => api.ativacao(id)));

server.registerTool('wait_for_sms', {
  title: 'Esperar o codigo chegar',
  description: 'Fica consultando a ativacao a cada 5 s ate o codigo chegar ou o tempo acabar (padrao 60 s, maximo 300). Devolve a ativacao com "codigo_chegou" true/false. Se nao chegou, chame de novo (o numero vale ~20 min) ou use resend_sms / cancel_activation.',
  inputSchema: {
    id: z.number().int().positive().describe('ID da ativacao.'),
    timeoutSeconds: z.number().int().min(5).max(300).default(60).describe('Tempo maximo de espera nesta chamada, em segundos. Alguns clientes MCP cortam ferramentas longas; prefira chamadas de ate 60 s.'),
  },
}, async ({ id, timeoutSeconds }) => executar(() => api.esperarSms(id, timeoutSeconds)));

server.registerTool('cancel_activation', {
  title: 'Cancelar ativacao',
  description: 'Cancela uma ativacao que ainda nao recebeu SMS e devolve o valor ao saldo. Nao funciona depois que o codigo chegou.',
  inputSchema: { id: z.number().int().positive().describe('ID da ativacao.') },
}, async ({ id }) => executar(() => api.cancelar(id)));

server.registerTool('complete_activation', {
  title: 'Concluir ativacao',
  description: 'Marca a ativacao como concluida depois de usar o codigo. Opcional, mas libera o numero mais cedo.',
  inputSchema: { id: z.number().int().positive().describe('ID da ativacao.') },
}, async ({ id }) => executar(() => api.concluir(id)));

server.registerTool('resend_sms', {
  title: 'Pedir reenvio do SMS',
  description: 'Pede ao fornecedor um novo SMS para a mesma ativacao (quando o servico permite reenviar o codigo). Use se o primeiro nao chegou.',
  inputSchema: { id: z.number().int().positive().describe('ID da ativacao.') },
}, async ({ id }) => executar(() => api.reenviar(id)));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`numero-virtual-mcp pronto (API ${baseUrl})`);
