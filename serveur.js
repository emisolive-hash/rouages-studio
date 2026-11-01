// Rouages Studio : petit serveur local (http://localhost:4747) + moteur de file.
// Lancement : double-clic sur « Rouages-Studio.bat » (ou : node serveur.js).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WINDOWS, ICI, DONNEES, source, lireConfig, ecrireConfig, journal, memoireJournal, executer } = require('./commun');
const { Moteur } = require('./moteur');
const medias = require('./medias');
const installation = require('./installation');
const createur = require('./createur');
const { depenses } = require('./claude');

const VERSION = '1.4';
const config = lireConfig();
const PORT = Number(process.env.ROUAGES_PORT || config.port || 4747);
const ADRESSE = `http://localhost:${PORT}`;

function ouvrirNavigateur() {
  if (process.env.ROUAGES_SANS_NAVIGATEUR || !config.ouvrirNavigateur) return;
  // fenêtre d'application (Edge en mode app, sans barre d'adresse), sinon le navigateur par défaut
  if (WINDOWS) executer('cmd', ['/c', 'start', '', 'msedge', `--app=${ADRESSE}`, '--window-size=580,1020']).then((r) => { if (r.code !== 0) executer('cmd', ['/c', 'start', '', ADRESSE]); });
  else executer('xdg-open', [ADRESSE]);
}

const moteur = new Moteur();
const VERROU = path.join(DONNEES, 'moteur-actif.txt');

function repondre(res, code, obj, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
}

function lireCorps(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

const serveur = http.createServer(async (req, res) => {
  try {
    // le menu ne répond qu'à ce PC
    const hote = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(hote)) return repondre(res, 403, { erreur: 'accès local seulement' });
    const url = new URL(req.url, ADRESSE);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return repondre(res, 200, fs.readFileSync(path.join(ICI, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/etat') {
      const c = lireConfig();
      return repondre(res, 200, Object.assign({ version: VERSION, premierLancementFait: !!c.premierLancementFait, source: source(c) }, moteur.public()));
    }
    if (req.method === 'GET' && url.pathname === '/api/medias') return repondre(res, 200, { episodes: medias.lister(), voix: medias.voixDisponibles() });
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const p = medias.resoudre(decodeURIComponent(url.pathname.slice(7)));
      if (!p) return repondre(res, 404, { erreur: 'fichier introuvable' });
      return medias.servirFichier(req, res, p);
    }
    if (req.method === 'GET' && url.pathname === '/apercu.png') {
      const p = moteur.imageApercu();
      if (!p || !fs.existsSync(p)) return repondre(res, 404, { erreur: 'pas d’aperçu' });
      return medias.servirFichier(req, res, p);
    }
    if (req.method === 'GET' && url.pathname === '/api/journal') return repondre(res, 200, { lignes: memoireJournal.slice(-150) });
    if (req.method === 'GET' && url.pathname === '/api/reglages') {
      // la clé Claude ne quitte jamais le serveur : on dit seulement si elle existe
      const c = lireConfig();
      return repondre(res, 200, Object.assign({}, c, { cleClaude: '', cleClaudeEnregistree: !!c.cleClaude,
        publication: Object.assign({}, c.publication, { jeton: '', jetonEnregistre: !!(c.publication && c.publication.jeton) }) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/installation') return repondre(res, 200, await installation.diagnostic());
    if (req.method === 'GET' && url.pathname === '/guide') {
      return repondre(res, 200, fs.readFileSync(path.join(ICI, 'GUIDE.md')), 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/reglages') {
      // protection simple contre un site web qui posterait ici : on exige l'en-tête ajouté par notre page
      if (req.headers['x-rouages'] !== '1') return repondre(res, 403, { erreur: 'refusé' });
      const corps = await lireCorps(req);
      delete corps.cleClaude; delete corps.source; delete corps.publication;    // ces deux-là passent par /api/installation/…
      ecrireConfig(corps);
      journal('Réglages enregistrés.');
      moteur.action('rafraichir').catch(() => {});
      return repondre(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/creation') {
      const c = lireConfig();
      return repondre(res, 200, Object.assign(createur.etat(), {
        cle: !!c.cleClaude, depenses: depenses(), voix: medias.voixDisponibles(),
        reglages: { categories: c.categories, modeCreation: c.modeCreation, apprendre: c.apprendre, ligneEditoriale: c.ligneEditoriale, dureeCible: c.dureeCible, voixParDefaut: c.voixParDefaut, modeleClaude: c.modeleClaude },
        publication: { outil: (c.publication || {}).outil, compte: (c.publication || {}).compte, jetonEnregistre: !!(c.publication || {}).jeton },
      }));
    }
    if (req.method === 'POST' && (url.pathname.startsWith('/api/creation/') || url.pathname === '/api/publication/reglages')) {
      if (req.headers['x-rouages'] !== '1') return repondre(res, 403, { erreur: 'refusé' });
      const corps = await lireCorps(req);
      const quoi = url.pathname.split('/').pop();
      try {
        if (url.pathname === '/api/publication/reglages') {
          const avant = lireConfig().publication || {};
          ecrireConfig({ publication: { outil: corps.outil || avant.outil, compte: corps.compte ?? avant.compte, jeton: corps.jeton ? String(corps.jeton).trim() : avant.jeton } });
          return repondre(res, 200, { ok: true });
        }
        if (quoi === 'idees') return repondre(res, 200, await createur.proposerIdees(corps.categories, corps.parCategorie));
        if (quoi === 'selection') { createur.selectionner(corps.ids); return repondre(res, 200, { ok: true }); }
        if (quoi === 'creer') return repondre(res, 200, { projets: createur.creer(corps.ids || [], corps, moteur.taches).length });
        if (quoi === 'projet') { createur.actionProjet(corps.id, corps.action, corps.texte); return repondre(res, 200, { ok: true }); }
        if (quoi === 'reglages') {
          const garder = ['categories', 'modeCreation', 'apprendre', 'ligneEditoriale', 'dureeCible', 'voixParDefaut', 'modeleClaude'];
          const o = {}; for (const k of garder) if (corps[k] !== undefined) o[k] = corps[k];
          ecrireConfig(o); return repondre(res, 200, { ok: true });
        }
      } catch (e) { return repondre(res, 400, { erreur: e.message }); }
      return repondre(res, 404, { erreur: 'introuvable' });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/installation/')) {
      if (req.headers['x-rouages'] !== '1') return repondre(res, 403, { erreur: 'refusé' });
      const corps = await lireCorps(req);
      const quoi = url.pathname.slice('/api/installation/'.length);
      try {
        if (quoi === 'choisir-dossier') return repondre(res, 200, { chemin: await installation.choisirDossier(corps.titre) });
        if (quoi === 'installer') return repondre(res, 200, { ok: await installation.installer(corps.logiciel) });
        if (quoi === 'cle-claude') return repondre(res, 200, await installation.enregistrerCle(corps.cle));
        if (quoi === 'source') { const src = await installation.configurerSource(corps); await moteur.action('rafraichir'); return repondre(res, 200, { ok: true, source: src }); }
        if (quoi === 'travail') return repondre(res, 200, { ok: true, chemin: installation.configurerTravail(corps.chemin) });
        if (quoi === 'terminer') { ecrireConfig({ premierLancementFait: true }); journal('Guide de démarrage terminé.'); return repondre(res, 200, { ok: true }); }
      } catch (e) { return repondre(res, 400, { erreur: e.message }); }
      return repondre(res, 404, { erreur: 'introuvable' });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (req.headers['x-rouages'] !== '1') return repondre(res, 403, { erreur: 'refusé' });
      const corps = await lireCorps(req);
      if (corps.action === 'quitter') {
        repondre(res, 200, { ok: true });
        journal('Fermeture du menu demandée.');
        await moteur.arreterTout();
        try { fs.unlinkSync(VERROU); } catch (e) { /* rien */ }
        setTimeout(() => process.exit(0), 300);
        return;
      }
      if (corps.action === 'ouvrir-fichier') return repondre(res, medias.ouvrir(corps.dossier) ? 200 : 404, { ok: true });
      await moteur.action(corps.action, corps.dossier);
      return repondre(res, 200, { ok: true });
    }
    repondre(res, 404, { erreur: 'introuvable' });
  } catch (e) {
    repondre(res, 500, { erreur: e.message });
  }
});

serveur.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // le menu tourne déjà : on ouvre juste la page
    console.log(`Le menu tourne déjà : ${ADRESSE}`);
    ouvrirNavigateur();
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error(e);
    process.exit(1);
  }
});

serveur.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(VERROU, `Rouages Studio actif (pid ${process.pid}) depuis ${new Date().toISOString()}\n${ADRESSE}\n`, 'utf8');
  journal(`Menu ouvert sur ${ADRESSE}`);
  ouvrirNavigateur();
  moteur.demarrer();
  createur.quandDepose(() => moteur.action('rafraichir'));
  createur.reprendre();
});

async function fermer() {
  await moteur.arreterTout();
  try { fs.unlinkSync(VERROU); } catch (e) { /* rien */ }
  process.exit(0);
}
process.on('SIGINT', fermer);
process.on('SIGTERM', fermer);
