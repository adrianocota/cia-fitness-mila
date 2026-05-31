import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { gerarResposta } from './openai.js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ─── BUSCAR PERFIL ────────────────────────────────────────────────────────────

export async function buscarPerfil(leadId) {
  try {
    const { data, error } = await supabase
      .from('lead_profile')
      .select('*')
      .eq('lead_id', leadId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('❌ Erro ao buscar perfil:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.error('❌ Erro ao buscar perfil:', e.message);
    return null;
  }
}

// ─── CRIAR PERFIL VAZIO ───────────────────────────────────────────────────────

export async function criarPerfilVazio(leadId) {
  try {
    const { data, error } = await supabase
      .from('lead_profile')
      .insert({ lead_id: leadId })
      .select()
      .single();

    if (error) {
      console.error('❌ Erro ao criar perfil:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.error('❌ Erro ao criar perfil:', e.message);
    return null;
  }
}

// ─── ATUALIZAR PERFIL ─────────────────────────────────────────────────────────

export async function atualizarPerfil(leadId, campos) {
  try {
    // Remove campos undefined/null para não sobrescrever dados existentes
    const camposLimpos = Object.fromEntries(
      Object.entries(campos).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );

    if (Object.keys(camposLimpos).length === 0) return;

    const { error } = await supabase
      .from('lead_profile')
      .upsert({ lead_id: leadId, ...camposLimpos }, { onConflict: 'lead_id' });

    if (error) {
      console.error('❌ Erro ao atualizar perfil:', error.message);
    }
  } catch (e) {
    console.error('❌ Erro ao atualizar perfil:', e.message);
  }
}

// ─── EXTRAIR PERFIL DA CONVERSA ───────────────────────────────────────────────
// Roda em background após cada mensagem processada.
// Analisa as últimas mensagens e extrai informações estruturadas do lead.

export async function extrairEAtualizarPerfil(leadId, historico) {
  if (!historico || historico.length < 2) return;

  // Pega só as últimas 10 mensagens para economizar tokens
  const ultimasMensagens = historico.slice(-10);
  const textoHistorico = ultimasMensagens
    .map((m) => (m.role === 'user' ? 'Lead' : 'Mila') + ': ' + m.content)
    .join('\n');

  const prompt = `Você é um extrator de dados ESTRITO. Sua única função é identificar o que o LEAD disse EXPLICITAMENTE.

REGRAS ABSOLUTAS:
1. Use null para TUDO que o lead não disse com palavras claras.
2. NUNCA infira, suponha ou interprete além do que foi dito literalmente.
3. Perguntar sobre algo NÃO significa ter interesse naquilo. Ex: lead perguntou sobre Gympass → tem_gympass = null (não sabemos se tem). Só marque true se o lead DISSE "tenho Gympass" ou "uso Gympass".
4. Horário preferido = null a menos que o lead tenha dito "prefiro manhã", "só posso à noite", "treino de manhã", etc.
5. Plano de interesse = null a menos que o lead tenha dito "quero o mensal", "prefiro o anual", etc. Perguntar sobre um plano NÃO é interesse.
6. Nível de interesse: só classifique se o comportamento for claro. Dúvidas e perguntas = "medio". Nunca classifique como "alto" só por perguntar.

EXEMPLOS DO QUE NÃO FAZER:
- Lead perguntou "vocês aceitam Gympass?" → NÃO marque tem_gympass: true
- Lead perguntou "qual o horário de manhã?" → NÃO marque horario_preferido: "manhã"
- Lead disse "quero saber sobre o plano anual" → NÃO marque plano_interesse: "anual"
- Lead disse "estou pensando em entrar" → NÃO marque nivel_interesse: "alto"

EXEMPLOS DO QUE FAZER:
- Lead disse "eu tenho Gympass Silver" → tem_gympass: true
- Lead disse "só posso treinar à noite" → horario_preferido: "noite"
- Lead disse "quero assinar o anual" → plano_interesse: "anual"
- Lead disse "to querendo emagrecer" → objetivo: "emagrecer"
- Lead disse "já treinei aqui antes" → ex_aluno: true
- Lead disse "tenho hérnia de disco" → restricao_saude: "hérnia de disco"

Conversa para analisar:
${textoHistorico}

Responda APENAS com JSON válido. Use null para tudo que não foi dito explicitamente.

{
  "objetivo": null,
  "objetivo_especifico": null,
  "horario_preferido": null,
  "dias_disponiveis": null,
  "tempo_disponivel": null,
  "plano_interesse": null,
  "objecao_principal": null,
  "objecao_secundaria": null,
  "restricao_saude": null,
  "medico_liberou": null,
  "gestante": null,
  "tem_experiencia_academia": null,
  "ex_aluno": null,
  "modalidade_interesse": null,
  "nao_quer_musculacao": null,
  "forma_pagamento_preferida": null,
  "tem_gympass": null,
  "tem_totalpass": null,
  "sentimento_atual": null,
  "nivel_interesse": null
}

Valores possíveis:
- objetivo: "emagrecer" | "ganhar massa" | "saúde" | "definir" | "condicionamento" | "voltar a treinar"
- horario_preferido: "manhã" | "tarde" | "noite" | "qualquer" — SÓ se o lead disse explicitamente
- plano_interesse: "mensal" | "anual" | "economica" | "clube" | "gympass" | "totalpass" — SÓ se o lead demonstrou preferência clara
- objecao_principal: "preço" | "compromisso" | "horario" | "saude" | "distancia" | "tempo" | "atendimento"
- sentimento_atual: "positivo" | "neutro" | "negativo" | "frustrado" | "desistindo"
- nivel_interesse: "alto" | "medio" | "baixo"
- Booleanos: true | false | null — prefira null quando houver qualquer dúvida`;

  try {
    const resposta = await gerarResposta({
      systemPrompt: 'Você é um extrator de dados. Responda APENAS com JSON válido, sem markdown, sem explicações.',
      historico: [],
      mensagemNova: prompt,
    });

    // Remove possíveis markdown backticks
    const jsonLimpo = resposta.replace(/```json|```/g, '').trim();
    const dados = JSON.parse(jsonLimpo);

    await atualizarPerfil(leadId, dados);
    console.log(`📊 Perfil atualizado para lead ${leadId}`);
  } catch (e) {
    console.error('❌ Erro ao extrair perfil:', e.message);
    // Falha silenciosa — não impacta o fluxo principal
  }
}

// ─── FORMATAR PERFIL PARA O PROMPT ───────────────────────────────────────────
// Converte o perfil estruturado em texto legível para o system prompt.

export function formatarPerfilParaPrompt(perfil) {
  if (!perfil) return '';

  const linhas = [];

  if (perfil.objetivo) linhas.push(`Objetivo: ${perfil.objetivo}${perfil.objetivo_especifico ? ' (' + perfil.objetivo_especifico + ')' : ''}`);
  if (perfil.horario_preferido) linhas.push(`Horário preferido: ${perfil.horario_preferido}`);
  if (perfil.dias_disponiveis) linhas.push(`Frequência: ${perfil.dias_disponiveis}`);
  if (perfil.tempo_disponivel) linhas.push(`Tempo disponível: ${perfil.tempo_disponivel}`);
  if (perfil.plano_interesse) linhas.push(`Plano de interesse: ${perfil.plano_interesse}`);
  if (perfil.objecao_principal) linhas.push(`Objeção principal: ${perfil.objecao_principal}`);
  if (perfil.objecao_secundaria) linhas.push(`Objeção secundária: ${perfil.objecao_secundaria}`);
  if (perfil.restricao_saude) linhas.push(`Restrição de saúde: ${perfil.restricao_saude}`);
  if (perfil.medico_liberou === true) linhas.push(`Médico liberou: sim`);
  if (perfil.medico_liberou === false) linhas.push(`Médico liberou: não`);
  if (perfil.gestante) linhas.push(`Gestante: sim`);
  if (perfil.modalidade_interesse) linhas.push(`Modalidade de interesse: ${perfil.modalidade_interesse}`);
  if (perfil.nao_quer_musculacao) linhas.push(`Não quer musculação: sim`);
  if (perfil.forma_pagamento_preferida) linhas.push(`Forma de pagamento: ${perfil.forma_pagamento_preferida}`);
  if (perfil.tem_gympass) linhas.push(`Tem Gympass/Wellhub: sim`);
  if (perfil.tem_totalpass) linhas.push(`Tem Totalpass: sim`);
  if (perfil.ex_aluno) linhas.push(`Ex-aluno da Cia: sim`);
  if (perfil.sentimento_atual) linhas.push(`Estado emocional: ${perfil.sentimento_atual}`);
  if (perfil.nivel_interesse) linhas.push(`Nível de interesse: ${perfil.nivel_interesse}`);

  if (linhas.length === 0) return '';

  return `\n═══════════════════════════════════════════════════════
PERFIL DO LEAD — use para personalizar as respostas e NÃO repetir perguntas já respondidas:
═══════════════════════════════════════════════════════
${linhas.join('\n')}
═══════════════════════════════════════════════════════\n`;
}

// ─── GERAR RESUMO PARA HANDOFF ────────────────────────────────────────────────
// Gera um briefing estruturado para a Thaise quando o lead é escalado.

export async function gerarResumoHandoff(lead, perfil, historico) {
  const perfilTexto = perfil ? formatarPerfilParaPrompt(perfil) : 'Perfil não disponível.';
  const ultimasMensagens = (historico || []).slice(-6)
    .map((m) => (m.role === 'user' ? '👤 Lead' : '🤖 Mila') + ': ' + m.content)
    .join('\n');

  const prompt = `Crie um briefing CURTO e DIRETO para a atendente humana que vai assumir esta conversa.
Máximo 5 linhas. Português informal. Foque no que ela precisa saber para continuar sem repetir perguntas.

Dados do lead:
- Nome: ${lead.nome || 'não informado'}
- Telefone: ${lead.telefone}
${perfilTexto}

Últimas mensagens:
${ultimasMensagens}

Formato:
"Lead: [nome]. [O que quer]. [Onde está na jornada]. [Objeção se houver]. [O que fazer agora]."`;

  try {
    const resumo = await gerarResposta({
      systemPrompt: 'Você gera briefings curtos para atendentes. Seja direto e objetivo.',
      historico: [],
      mensagemNova: prompt,
    });
    return resumo;
  } catch (e) {
    console.error('❌ Erro ao gerar resumo de handoff:', e.message);
    return null;
  }
}
