// Connexion au compte de publication (Metricool). Le jeton reste sur ce PC, dans donnees\config.json.
'use strict';
const https = require('https');
const http = require('http');
const { lireConfig, ecrireConfig, journal } = require('./commun');

// Où l'utilisateur trouve ses infos : Metricool › son profil (en haut à droite) › Paramètres du compte › API.
const PAGE_API = 'https://app.metricool.com/';

function getJson(chemin, jeton) {
  return new Promise((resolve) => {
    // ROUAGES_METRICOOL_URL : adresse de remplacement, pour les tests
    const u = new URL(process.env.ROUAGES_METRICOOL_URL || 'https://app.metricool.com');
    const req = (u.protocol === 'http:' ? http : https).request({
      hostname: u.hostname, port: u.port || undefined, path: '/api' + chemin, method: 'GET', timeout: 15000,
      headers: { 'X-Mc-Auth': jeton, Accept: 'application/json' },
    }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* pas du JSON */ } resolve({ code: res.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', (e) => resolve({ code: 0, erreur: e.message }));
    req.end();
  });
}

// Vérifie le jeton + l'identifiant, et rend la liste des marques du compte (pour choisir laquelle utiliser).
async function testerMetricool(jeton, utilisateur) {
  jeton = String(jeton || '').trim(); utilisateur = String(utilisateur || '').trim();
  if (!jeton) return { ok: false, erreur: 'Colle d’abord le jeton (« Access token »).' };
  if (!/^\d+$/.test(utilisateur)) return { ok: false, erreur: 'L’identifiant (« User ID ») est un nombre.' };
  const r = await getJson(`/admin/simpleProfiles?userId=${utilisateur}&integrationSource=RouagesStudio`, jeton);
  if (r.code === 0) return { ok: false, erreur: `Pas de connexion à Metricool : ${r.erreur}` };
  if (r.code === 401 || r.code === 403) return { ok: false, erreur: 'Metricool refuse ce jeton ou cet identifiant. Vérifie-les (l’API demande l’offre Advanced ou plus).' };
  if (r.code !== 200) return { ok: false, erreur: `Réponse inattendue de Metricool (${r.code}).` };
  const liste = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.data) ? r.json.data : []);
  const marques = liste.map((m) => ({ id: String(m.id ?? m.blogId ?? ''), nom: m.label || m.title || m.name || `Marque ${m.id}` })).filter((m) => m.id);
  return { ok: true, marques };
}

async function connecter({ jeton, utilisateur, compte, compteNom }) {
  const avant = lireConfig().publication || {};
  const j = String(jeton || '').trim() || avant.jeton;
  const u = String(utilisateur || '').trim() || avant.utilisateur;
  const t = await testerMetricool(j, u);
  if (!t.ok) return t;
  let choix = t.marques.find((m) => m.id === String(compte || '')) || (t.marques.length === 1 ? t.marques[0] : null);
  ecrireConfig({ publication: { outil: 'metricool', jeton: j, utilisateur: u, compte: choix ? choix.id : '', compteNom: choix ? choix.nom : (compteNom || '') } });
  journal(`Metricool connecté${choix ? ` (marque ${choix.nom})` : ''}.`);
  return { ok: true, marques: t.marques, compte: choix ? choix.id : '' };
}

function deconnecter() {
  ecrireConfig({ publication: { outil: 'metricool', jeton: '', utilisateur: '', compte: '', compteNom: '' } });
  journal('Metricool déconnecté.');
  return { ok: true };
}

module.exports = { testerMetricool, connecter, deconnecter, PAGE_API };
