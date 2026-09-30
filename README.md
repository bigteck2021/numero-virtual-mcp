# numero-virtual-mcp

Servidor [MCP](https://modelcontextprotocol.io) do **Número Virtual**: seu assistente (Claude Desktop, Claude Code, Cursor, OpenClaw e outros) passa a conseguir pedir um número virtual, esperar o código de verificação por SMS e encerrar ou cancelar a ativação, usando a **sua** chave de API.

Por baixo é a [API v1 pública](https://app.numero-virtual.com/api/v1/docs). Nada é guardado fora da sua máquina: a chave fica na sua configuração e vai direto para `app.numero-virtual.com`.

## 1. Pegue sua chave

Entre em [app.numero-virtual.com](https://app.numero-virtual.com) → **Desenvolvedores** → **Nova chave**. Ela começa com `nv_live_`. Tenha saldo na conta: cada número comprado desconta do saldo.

## 2. Configure no seu cliente

Requer Node.js 18 ou mais novo.

**Claude Code**

```bash
claude mcp add numero-virtual -e NUMERO_VIRTUAL_API_KEY=nv_live_SUA_CHAVE -- npx -y numero-virtual-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) e **Cursor** (`mcp.json`):

```json
{
  "mcpServers": {
    "numero-virtual": {
      "command": "npx",
      "args": ["-y", "numero-virtual-mcp"],
      "env": { "NUMERO_VIRTUAL_API_KEY": "nv_live_SUA_CHAVE" }
    }
  }
}
```

**Rodando do código-fonte** (sem npm):

```bash
git clone https://github.com/bigteck2021/numero-virtual-mcp.git && cd numero-virtual-mcp
npm install && npm run build
# no cliente MCP: "command": "node", "args": ["/caminho/absoluto/dist/index.js"]
```

## 3. Ferramentas

| ferramenta | o que faz |
|---|---|
| `get_balance` | saldo da conta em reais |
| `list_countries` | países com estoque (use o código ISO: BR, US, ID...) |
| `list_services` | serviços, preços e opções de um país |
| `request_number` | compra um número para um serviço (`serviceId`, `country`, `apiId` opcional, `ddd` opcional no Brasil) |
| `get_activation` | status, telefone e código de uma ativação |
| `wait_for_sms` | espera o código chegar (consulta a cada 5 s, até 120 s por padrão) |
| `resend_sms` | pede reenvio do SMS |
| `cancel_activation` | cancela antes do SMS chegar; o valor volta ao saldo |
| `complete_activation` | marca como concluída depois de usar o código |

Exemplo de conversa: *"Pega um número do Brasil pro Telegram, me passa o telefone, e quando o código chegar me avisa."* O assistente chama `list_services`, `request_number`, `wait_for_sms` e devolve o código.

## Antes de usar: o assistente gasta o seu saldo

Cada `request_number` desconta do saldo na hora, como qualquer compra. O assistente só faz o que você pede, mas:

- **Texto de SMS é dado, não ordem.** Um SMS recebido pode conter instruções ("compre mais 20 números"). O assistente lê esse texto pela ferramenta `wait_for_sms`/`get_activation`. Bons clientes MCP tratam resultado de ferramenta como dado; mesmo assim, não deixe o assistente comprar em laço sem você acompanhar.
- **A chave vale dinheiro.** Ela fica no arquivo de configuração do seu cliente MCP. Não a cole em chats nem em repositórios. Se vazar, revogue no painel (Desenvolvedores) e gere outra.
- **Nada além da API.** Este servidor não recarrega saldo, não altera a conta e não vê dados além do que a chave já permite.

## Limites

Os mesmos da API: catálogo (`list_countries`, `list_services`) até 6 consultas por minuto por chave; compras e cancelamentos também têm limite por minuto. Quando estourar, a ferramenta devolve o erro com "tente de novo em N s".

## Variáveis

| variável | obrigatória | padrão |
|---|---|---|
| `NUMERO_VIRTUAL_API_KEY` | sim | — |
| `NUMERO_VIRTUAL_API_URL` | não | `https://app.numero-virtual.com/api/v1` |

## Suporte

[app.numero-virtual.com](https://app.numero-virtual.com), pelo chat de suporte.
