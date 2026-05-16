Cia Fitness Mila
Assistente virtual de WhatsApp da Cia do Fitness para atendimento de leads de tráfego pago.
O que é
Sistema automatizado que atende leads que chegam pelo WhatsApp via campanhas do Meta Ads e disparos do ChatPRO. Qualifica o lead, tira dúvidas sobre planos da academia, faz follow-up de quem não respondeu, e transfere pro vendedor humano quando o lead está pronto pra fechar matrícula.
Stack
Runtime: Node.js 20+
Framework: Express
Banco de dados: Supabase (PostgreSQL)
IA: OpenAI (GPT-4o-mini)
WhatsApp: Z-API (não oficial)
Hospedagem: Railway
Versionamento: GitHub
Arquitetura
```
Lead (WhatsApp) → Z-API → Backend (Railway) → OpenAI → Resposta
                              ↓
                          Supabase
                       (histórico + leads)
```
O backend escuta webhooks da Z-API quando chega mensagem de lead, processa com a IA, e responde via Z-API. Em paralelo, um cron job dispara follow-ups automáticos pra leads que não responderam.
Estrutura do projeto
```
src/
├── server.js               # Servidor Express (recebe webhooks)
├── config.js               # Configurações centralizadas
├── handlers/               # Lógica de processamento
├── services/               # Conexões com APIs externas
├── lib/                    # Funções auxiliares
└── data/                   # Base de conhecimento (markdown)

scripts/
└── setupDatabase.sql       # Script de criação das tabelas
```
Variáveis de ambiente necessárias
Veja `.env.example`. Todas configuradas como variáveis de ambiente no Railway.
Como rodar localmente
```bash
npm install
cp .env.example .env
# Preencher .env com as credenciais
npm start
```
Deploy
Deploy automático via Railway sempre que houver push na branch `main`.
Manutenção
Base de conhecimento: edita o arquivo `src/data/base_conhecimento.md`, commit, deploy automático
Campanha vigente: edita `src/data/oferta_vigente.md`, commit, deploy automático
Sequência de follow-up: edita `src/data/sequencia_followup.md`, commit, deploy automático
Documentação interna
Base de conhecimento da Mila: `src/data/base_conhecimento.md`
Oferta vigente da campanha: `src/data/oferta_vigente.md`
Sequência de follow-up: `src/data/sequencia_followup.md`
Suporte
Projeto privado da Cia do Fitness. Para dúvidas, contatar Adriano.
