// Appels à Claude (SDK officiel Anthropic) : réponses en JSON validé par un schéma, coût suivi sur ce PC.
'use strict';
const path = require('path');
const { DONNEES, lireConfig, lireJson, ecrireJson, journal } = require('./commun');

const MODELE_DEFAUT = 'claude-opus-5-5';
// prix en dollars par million de jetons (entrée, sortie), pour estimer la dépense
const PRIX = {
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-1': [10, 50],
};
const FICHIER_DEPENSES = path.join(DONNEES, 'depenses.json');

let SDK = null;
function sdk() {
  if (!SDK) {
    try { SDK = require('@anthropic-ai/sdk'); } catch (e) {
      throw new Error('Le module Claude n’est pas installé : ferme Rouages Studio et relance Rouages-Studio.bat (il l’installe tout seul).');
    }
  }
  return SDK.default || SDK;
}

function client(config) {
  const Anthropic = sdk();
  return new Anthropic({ apiKey: config.cleClaude, baseURL: process.env.ROUAGES_CLAUDE_URL || undefined, maxRetries: 2 });
}

function noterDepense(modele, usage, quoi) {
  const p = PRIX[modele];
  const dollars = p ? ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6 : 0;
  const d = lireJson(FICHIER_DEPENSES, { lignes: [] });
  d.lignes.push({ quand: Date.now(), quoi, modele, entree: usage.input_tokens || 0, sortie: usage.output_tokens || 0, dollars });
  if (d.lignes.length > 2000) d.lignes = d.lignes.slice(-2000);
  ecrireJson(FICHIER_DEPENSES, d);
  return dollars;
}

function depenses() {
  const d = lireJson(FICHIER_DEPENSES, { lignes: [] });
  const debutMois = new Date(); debutMois.setDate(1); debutMois.setHours(0, 0, 0, 0);
  const mois = d.lignes.filter((l) => l.quand >= debutMois.getTime());
  return { mois: mois.reduce((s, l) => s + l.dollars, 0), appelsMois: mois.length, total: d.lignes.reduce((s, l) => s + l.dollars, 0) };
}

// Demande une réponse JSON conforme à `schema`. effort : low | medium | high | xhigh | max.
async function demanderJson({ quoi, system, prompt, schema, effort = 'medium', maxTokens = 32000 }) {
  const config = lireConfig();
  if (!config.cleClaude) throw new Error('Aucune clé Claude : ajoute-la dans le guide (bouton « ? »).');
  const Anthropic = sdk();
  const modele = config.modeleClaude || MODELE_DEFAUT;
  let msg;
  try {
    const flux = client(config).beta.messages.stream({
      model: modele,
      max_tokens: maxTokens,
      // si Claude refuse pour une raison de sécurité, l'API relance d'elle-même sur le modèle de secours conseillé
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    });
    msg = await flux.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Clé Claude refusée : vérifie-la dans le guide.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('Cette clé n’a pas accès à ce modèle.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Trop de demandes d’un coup (ou crédit épuisé) : réessaie dans une minute.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Pas de connexion à Claude (internet ?).');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude a répondu une erreur (${e.status || '?'}) : ${String(e.message).slice(0, 200)}`);
    throw e;
  }
  const dollars = noterDepense(msg.model || modele, msg.usage || {}, quoi);
  journal(`Claude (${quoi}) : ${msg.usage ? msg.usage.output_tokens : '?'} jetons, ~${dollars.toFixed(3)} $.`);
  if (msg.stop_reason === 'refusal') throw new Error('Claude a refusé cette demande. Essaie de la formuler autrement.');
  if (msg.stop_reason === 'max_tokens') throw new Error('La réponse de Claude était trop longue et a été coupée. Réessaie.');
  const texte = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return { donnees: JSON.parse(texte), dollars }; }
  catch (e) { throw new Error('Réponse de Claude illisible, réessaie.'); }
}

module.exports = { demanderJson, depenses, MODELE_DEFAUT, PRIX };
