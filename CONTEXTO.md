# CONTEXTO DO PROJETO MILA — CIA DO FITNESS
> Cole este arquivo no início de qualquer sessão nova com o Claude para retomar o projeto sem perda de contexto.
> Última atualização: 03/06/2026

---

## 1. VISÃO GERAL

**Mila** é a atendente virtual da Cia do Fitness (academia em João Monlevade/MG, ~597 alunos ativos), com duas funções:

1. **Atendimento de leads via WhatsApp** — qualifica e converte leads vindos de tráfego pago (Meta Ads), responde dúvidas sobre planos, horários e estrutura, escala para humano quando necessário.
2. **CRM automático** — dispara mensagens personalizadas para alunos ativos, inativos e prospects em 13 gatilhos, com imagem + texto via WhatsApp.

**Número Mila:** (31) 99605-8310  
**Número alunos ativos (futuro):** (31) 38521601 — segunda instância Z-API, decisão pendente

---

## 2. STACK TÉCNICA

| Componente | Tecnologia |
|---|---|
| Hospedagem | Railway (Node.js 22, ESModules) — projeto "marvelous-gratitude" |
| URL produção | `https://cia-fitness-mila-production.up.railway.app` |
| Repositório | `github.com/adrianocota/cia-fitness-mila` (branch main) |
| Banco de dados | Supabase — projeto `hyvmfmynyjpocdtjayml` (São Paulo) |
| WhatsApp | Z-API — instância `3F337C3E80EFD1F05047D654E8E89E86` |
| IA | OpenAI GPT-4o-mini (migrar para gpt-4.1-mini — pendente) |
| Sistema gestão | EVO — `https://evo-integracao-api.w12app.com.br/api/v1` |
| EVO credenciais | DNS: `ciafitness` / Token: `59EA5FCF-5622-483A-B720-2C180A57887A` |
| Imagens CRM | Supabase Storage — bucket `Imagens` |
| Dashboard | `adrianocota.github.io/cia-fitness-mila/dashboard.html` |

---

## 3. ESTRUTURA DE ARQUIVOS

```
src/
├── server.js               — Express + rotas + crons
├── config.js               — variáveis de ambiente
├── crm/
│   ├── crmHandler.js       — orquestra 13 gatilhos → rodarCRM()
│   ├── evoService.js       — 13 funções de busca na API EVO
│   ├── mensagens.js        — textos + URLs de imagem por gatilho
│   └── evoCrmWebhook.js    — stub vazio (não usado ativamente)
├── handlers/
│   ├── webhookHandler.js   — recebe Z-API, processa, responde
│   └── followupHandler.js  — follow-up de leads (cron horário)
├── services/
│   ├── zapi.js             — enviarTexto(), enviarImagem(), parsearWebhook()
│   ├── supabase.js         — gravarLog(), buscarLead(), salvarMensagem() etc.
│   ├── openai.js           — geração de resposta + classificarIntencao()
│   └── leadProfile.js      — extração de perfil do lead (roda a cada 3 msgs)
├── lib/
│   ├── promptBuilder.js    — monta prompt com base de conhecimento (tem cache)
│   ├── messageClassifier.js — classificação unificada FECHAR/ENCERRAR/ESCALAR/CONTINUAR
│   └── escalation.js       — lógica de escalada para humano
└── public/
    └── dashboard_mila_v2.html
```

---

## 4. ROTAS DO SERVIDOR

| Rota | Método | Função |
|---|---|---|
| `/` | GET | health check |
| `/health` | GET | status + conexão Z-API |
| `/webhook` | POST | recebe mensagens Z-API |
| `/evo-crm` | POST | webhook EVO reservado (stub) |
| `/crm/transmissao` | POST | disparo manual em lista |
| `/trigger-followup` | POST | aciona follow-up manualmente |
| `/admin/cache/clear` | POST | limpa cache do promptBuilder |
| `/dashboard` | GET | dashboard HTML |

**Autenticação:** header `x-secret-token` = `config.zapi.token`

---

## 5. CRM AUTOMÁTICO — 13 GATILHOS

Cron roda diariamente às **08h (America/Sao_Paulo)** chamando `rodarCRM()`.  
Fluxo de envio: `enviarImagem(telefone, url, '')` → sleep 1500ms → `enviarTexto(telefone, texto)`  
Deduplicação: Set em memória `data:telefone:gatilho` (reseta a cada reinício).

| # | Chave | Descrição |
|---|---|---|
| 1 | `9_dias_sem_presenca` | Aluno sem presença há 9 dias |
| 2 | `18_dias_sem_presenca` | Aluno sem presença há 18 dias |
| 3 | `aniversario` | Aniversariante do dia |
| 4 | `1_dia_apos_matricula` | Boas-vindas |
| 5 | `30_dias_apos_matricula` | 1 mês de academia |
| 6 | `16_dias_antes_vencimento` | Aviso antecipado + link |
| 7 | `5_dias_apos_vencimento` | Plano vencido + link |
| 8 | `30_dias_apos_vencimento` | Ex-aluno — reconexão SEM cobrança |
| 9 | `cobranca_recusada` | Cobrança recusada hoje |
| 10 | `cobranca_recusada_3d` | Cobrança recusada há 3 dias |
| 11 | `cobranca_recusada_7d` | Cobrança recusada há 7 dias |
| 12 | `pos_visita` | Prospect que visitou ontem |
| 13 | `7_dias_apos_oportunidade` | Prospect cadastrado há 7 dias |

**Imagens:** todas no bucket `Imagens` do Supabase `hyvmfmynyjpocdtjayml`.  
**Link de pagamento:** `https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`  
**Bug corrigido em 03/06:** cobrança recusada agora busca telefone via `buscarMembroPorId()` — antes retornava null.

---

## 6. ATENDIMENTO MILA — FLUXO

```
Z-API webhook → /webhook → webhookHandler
  → deduplicação (messageId + hash conteúdo, janela 10s)
  → parsearWebhook()
  → buscarOuCriarLead()
  → guard de confirmação de reenvio  ← DEVE rodar ANTES do classifier
  → classificarIntencao() → FECHAR / ENCERRAR / ESCALAR / CONTINUAR
  → se CONTINUAR → promptBuilder → GPT-4o-mini → enviarTexto()
  → se FECHAR ou ESCALAR → gerarResumoHandoff() → transferirParaHumano()
  → se ENCERRAR → encerrarLead()
```

**Definições do classifier:**
- `FECHAR` — lead quer assinar/matricular agora: "quero assinar", "como pago"
- `ENCERRAR` — desistiu definitivamente: "não quero mais", "fechei em outro lugar"
- `ESCALAR` — pediu humano explicitamente, quer agendar visita confirmada, ou insistiu em desconto pela 2ª vez
- `CONTINUAR` — todo o resto (em caso de dúvida, usar CONTINUAR)

**Bug pendente:** guard de confirmação de reenvio precisa rodar ANTES do classifier — em alguns casos o classifier intercepta "Quero" (reenvio) e trata como FECHAR.

---

## 7. COMPORTAMENTO DA MILA — REGRAS CRÍTICAS

Estas regras foram refinadas ao longo de dezenas de sessões e NÃO devem ser alteradas sem motivo:

- **Nunca soar robótica** — tom humano, natural, pode usar "tô", "pra", "né"
- **Nunca repetir literalmente** a mesma frase em turnos consecutivos — usar reformulação semântica
- **Respostas de negação: curtas e diretas** — não explicar "somos uma academia de musculação"
- **Escalada = "a gerência"** — nunca citar nome da Thaise (pode mudar)
- **Nunca perguntar algo que o lead já respondeu** (Ajuste #41)
- **Perguntas só quando a conversa estagna** — nunca em sequência
- **Fast Training = aulas coletivas** (não é musculação individual)
- **Se lead tem nutricionista próprio** — não oferecer consulta nutricional novamente
- **Medicamentos (Ozempic, Wegovy, Manjaro etc.)** — detectar via GPT, variar resposta usando histórico
- **Modalidades não confirmadas** — não afirmar existência até confirmar com a equipe
- **Loja parceira** — "A loja dentro da academia é de um parceiro, então não tenho os detalhes dos produtos. Sei que o foco são roupas e acessórios de ginástica."
- **Nota fiscal** — "Sim, emitimos nota fiscal"
- **Pagamento em dinheiro** — mensal = só cartão; anual = dinheiro/Pix à vista
- **Staff perguntado por nome com afeto** — "Sou uma assistente virtual, então não tenho essa informação"
- **Nunca usar travessão (—)** — marcador de IA, usar vírgula ou reescrever
- **Tom em 3 níveis:** conectores sempre permitidos / reconhecimento emocional breve se contexto pedir / espelhar tom do lead só se o lead abriu primeiro

---

## 8. PLANOS DA CIA DO FITNESS

- Assinatura Mensal
- Assinatura Anual
- Assinatura Econômica Anual
- Plano Clube+ Anual

---

## 9. BASE DE CONHECIMENTO

**Versão atual:** v6.5  
**Localização:** `src/data/base_conhecimento.md` (lida pelo promptBuilder com cache)  
**Limpar cache:** `POST /admin/cache/clear` com header `x-secret-token`

---

## 10. SUPABASE — TABELAS

| Tabela | Uso |
|---|---|
| `leads` | perfil e status de cada lead |
| `mensagens` | histórico de conversas (limite: 20 msgs) |
| `followups` | registro de follow-ups enviados |
| `lead_profile` | perfil estruturado extraído pelo GPT (FK bigint) |
| `webhook_ids` | deduplicação por messageId |
| `mensagens_recentes` | deduplicação por hash conteúdo (janela 10s) |
| `error_logs` | log de erros e eventos |

---

## 11. EQUIPE E PESSOAS

| Pessoa | Papel |
|---|---|
| Adriano Cota | Dono da academia, responsável pelo projeto |
| Thaise | Gerente, audiência principal do dashboard, recebe escaladas |
| Gabi, Priscila, Gizelle | Recepcionistas |

**Grupo interno WhatsApp:** "Leads Cia Fitness" — recebe notificações de escalada com resumo gerado por GPT

---

## 12. CUSTOS MENSAIS (junho/2026)

| Serviço | Valor |
|---|---|
| Z-API (1 instância) | R$ 99,99 |
| Railway | ~R$ 25–30 |
| OpenAI | ~R$ 40–60 |
| Supabase | Grátis |
| ChatPRO | Cancelado |

---

## 13. DECISÕES PENDENTES

- [ ] Corrigir bug: guard de confirmação de reenvio deve rodar ANTES do classifier
- [ ] Migrar modelo para `gpt-4.1-mini`
- [ ] Adicionar cron CRM às 08h no `server.js` (atualmente não tem horário fixo para CRM)
- [ ] Segunda instância Z-API para separar número de alunos/número de vendas (R$99,99/mês)
- [ ] Implementar gatilho `reativacao` no `evoService.js`
- [ ] Testar 4 gatilhos novos em produção e validar logs Railway

---

## 14. HISTÓRICO RECENTE

| Data | O que foi feito |
|---|---|
| 03/06/2026 | mensagens.js (13 gatilhos + imagens), evoService.js (4 gatilhos novos + bug telefone corrigido), crmHandler.js (13 gatilhos), evoCrmWebhook.js (stub), CONTEXTO.md criado |
| 31/05/2026 | Base v6.2→v6.5, classificador unificado FECHAR/ENCERRAR/ESCALAR/CONTINUAR, lead_profile table (bigint FK), reformulação semântica, bug guard reenvio identificado |
| 28/05/2026 | Arquitetura CRM definida, URLs imagens Supabase mapeadas, ChatPRO cancelado |
| 19/05/2026 | 18+ ajustes comportamento Mila, deduplicador webhook, janela silêncio pós-escalada, reativação de lead, fluxograma automático, tabela de planos automática |
| 17/05/2026 | Criação do projeto: 15 arquivos, Railway deploy, Supabase configurado, Z-API, base v3 |

---

## COMO USAR ESTE ARQUIVO

Este arquivo está nas instruções do Projeto Claude "Mila — Cia do Fitness".
Toda conversa aberta dentro do projeto já carrega este contexto automaticamente.

