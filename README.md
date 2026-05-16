# Cia Fitness Mila

Assistente virtual de WhatsApp da Cia do Fitness para atendimento de leads de tráfego pago.

## O que é

Sistema automatizado que atende leads que chegam pelo WhatsApp via campanhas do Meta Ads e disparos do ChatPRO. Qualifica o lead, tira dúvidas sobre planos da academia, faz follow-up de quem não respondeu, e transfere pro vendedor humano quando o lead está pronto pra fechar matrícula.

## Stack

- **Runtime:** Node.js 20+
- **Framework:** Express
- **Banco de dados:** Supabase (PostgreSQL)
- **IA:** OpenAI (GPT-4o-mini)
- **WhatsApp:** Z-API (não oficial)
- **Hospedagem:** Railway
- **Versionamento:** GitHub

## Arquitetura

Lead (WhatsApp) → Z-API → Backend (Railway) → OpenAI → Resposta

Backend consulta histórico no Supabase a cada interação.

O backend escuta webhooks da Z-API quando chega mensagem de lead, processa com a IA, e responde via Z-API. Em paralelo, um cron job dispara follow-ups automáticos pra leads que não responderam.

## Estrutura do projeto

- `src/server.js` - Servidor Express (recebe webhooks)
- `src/config.js` - Configurações centralizadas
- `src/handlers/` - Lógica de processamento
- `src/services/` - Conexões com APIs externas
- `src/lib/` - Funções auxiliares
- `src/data/` - Base de conhecimento (markdown)
- `scripts/setupDatabase.sql` - Script de criação das tabelas

## Variáveis de ambiente necessárias

Veja `.env.example`. Todas configuradas como variáveis de ambiente no Railway.

## Como rodar localmente

Instalar dependências, copiar .env.example pra .env, preencher credenciais e rodar npm start.

## Deploy

Deploy automático via Railway sempre que houver push na branch main.

## Manutenção

- **Base de conhecimento:** edita o arquivo `src/data/base_conhecimento.md`, faz commit, deploy automático
- **Campanha vigente:** edita `src/data/oferta_vigente.md`, faz commit, deploy automático
- **Sequência de follow-up:** edita `src/data/sequencia_followup.md`, faz commit, deploy automático

## Documentação interna

- Base de conhecimento da Mila: `src/data/base_conhecimento.md`
- Oferta vigente da campanha: `src/data/oferta_vigente.md`
- Sequência de follow-up: `src/data/sequencia_followup.md`

## Suporte

Projeto privado da Cia do Fitness. Para dúvidas, contatar Adriano.
