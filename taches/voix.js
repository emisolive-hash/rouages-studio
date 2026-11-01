// Génération d'une voix avec un script voix.py local (ex. VoxCPM2), puis envoi dans pc-vers-cloud.
'use strict';
const fs = require('fs');
const path = require('path');
const { WINDOWS, source, lancerLong, journal } = require('../commun');
const { livrer } = require('../atelier-git');

// Dossier qui contient voix.py : le réglage, sinon pc-voix\voix-officielle à côté de la file de tâches.
function dossierVoix(config) {
  if (config.dossierVoix) return config.dossierVoix;
  const src = source(config);
  if (src) {
    const p = path.resolve(src.chemin, '..', 'pc-voix', 'voix-officielle');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function trouverPython(config) {
  if (config.python) return config.python;
  const d = dossierVoix(config);
  if (!d) return WINDOWS ? 'python' : 'python3';
  const exe = WINDOWS ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const base of [d, path.dirname(d)]) {
    for (const v of ['.venv', 'venv', 'env']) {
      const p = path.join(base, v, ...exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return WINDOWS ? 'python' : 'python3';
}

async function genererVoix(ctx) {
  const { tache: t, travail, config, suivi } = ctx;
  const dv = dossierVoix(config);
  if (!dv || !fs.existsSync(path.join(dv, 'voix.py'))) return { erreur: `voix.py introuvable dans ${dv} (réglage « Dossier des voix »)` };
  const args = t.argsVoix.slice();
  const texte = args[0];
  const sousDossier = args[2];
  fs.copyFileSync(path.join(travail, 'src', texte), path.join(dv, texte));
  const python = trouverPython(config);
  const debut = Date.now();
  const nbPrises = Number(args[1]) || 3;
  const estimation = (ctx.meta.secondesParPrise || 150) * nbPrises;
  Object.assign(suivi, { etape: `Voix : ${nbPrises} prises`, images: 0, total: 0, plan: 0, debutPlan: debut, estimationSecondes: estimation, derniereLigne: '' });
  journal(`${t.ep} : génération de la voix (${python} voix.py ${args.join(' ')}).`);

  const { enfant, fin } = lancerLong(python, ['voix.py', ...args], { cwd: dv, env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } }, (ligne) => {
    suivi.derniereLigne = ligne.slice(0, 200);
    const m = ligne.match(/prise\s*(\d+)/i);
    if (m) suivi.priseEnCours = Number(m[1]);
    if (/error|erreur|traceback/i.test(ligne)) journal(`voix.py : ${ligne.slice(0, 300)}`);
  });
  ctx.controle.enfant = enfant;
  const r = await fin;
  ctx.controle.enfant = null;
  if (ctx.controle.arreter) return { pause: true };
  if (r.code !== 0) return { erreur: r.code === -1 ? `Python introuvable (${python})` : `voix.py s'est arrêté (code ${r.code}) : ${suivi.derniereLigne}` };

  const secondes = (Date.now() - debut) / 1000;
  ctx.meta.secondesParPrise = secondes / nbPrises;
  ctx.sauverMeta();

  // fichiers produits pendant cette génération
  const dossierSortie = path.join(dv, sousDossier);
  const nouveaux = (fs.existsSync(dossierSortie) ? fs.readdirSync(dossierSortie) : [])
    .filter((f) => fs.statSync(path.join(dossierSortie, f)).mtimeMs >= debut - 2000);
  let garder = nouveaux.filter((f) => /-pose(-mots)?\.(mp3|wav|json)$/i.test(f));
  if (!garder.length) garder = nouveaux.filter((f) => /\.(mp3|wav|json)$/i.test(f));
  if (!garder.some((f) => /\.(mp3|wav)$/i.test(f))) return { erreur: `aucune voix trouvée dans ${dossierSortie} après la génération` };

  suivi.etape = "Envoi des voix";
  await livrer(t.sortie, garder.map((f) => ({ source: path.join(dossierSortie, f), nom: f })), [],
    `${t.ep} : ${nbPrises} prises voix officielle (${t.sortie}), menu`);
  return { ok: true, secondes: Math.round(secondes), medias: garder.filter((f) => /\.(mp3|wav)$/i.test(f)).map((f) => `a/${t.sortie}/${f}`) };
}

module.exports = { genererVoix, trouverPython, dossierVoix };
