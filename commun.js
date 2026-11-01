// Outils partagés du menu de rendu Rouages : chemins, réglages, journal, lancement de programmes.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const WINDOWS = process.platform === 'win32';
const ICI = __dirname;                                       // dossier de l'application

// Cas particulier : l'application est rangée dans un dépôt « file de tâches » (dossier qui contient
// cloud-vers-pc/), deux niveaux au-dessus. Elle s'en sert alors sans configuration.
const DEPOT_PARENT = path.resolve(ICI, '..', '..');
const DANS_UN_DEPOT = fs.existsSync(path.join(DEPOT_PARENT, 'cloud-vers-pc'));

// Données de l'application (réglages, état, journal) : jamais dans un dépôt git.
const DONNEES = process.env.ROUAGES_DONNEES
  || (DANS_UN_DEPOT ? path.join(path.dirname(DEPOT_PARENT), 'menu-rendu-donnees') : path.join(ICI, 'donnees'));
fs.mkdirSync(DONNEES, { recursive: true });

// ---------- réglages ----------
const FICHIER_CONFIG = path.join(DONNEES, 'config.json');
const DEFAUT = {
  port: 4747,
  ouvrirNavigateur: true,
  premierLancementFait: false,       // le tuto s'affiche tant que c'est faux
  source: null,                      // { type: 'git' | 'dossier', chemin } : la file de tâches
  dossierTravail: '',                // vide = donnees\travail (images en cours de rendu, gros fichiers)
  cleClaude: '',                     // clé API Claude (facultative, gardée sur ce PC uniquement)
  releveMinutes: 5,                  // toutes les combien de minutes on regarde la file
  ignorerAvant: '',                  // AAAA-MM-JJ : ignorer les tâches plus anciennes
  blender: '',                       // vide = trouvé tout seul
  ffmpeg: '',                        // vide = ffmpeg du PATH (ou winget)
  python: '',                        // vide = venv du dossier des voix s'il existe, sinon « python »
  dossierVoix: '',                   // dossier qui contient voix.py (facultatif)
  voixReference: '',                 // fichier reference*.wav à mettre en avant (vide = automatique)
  crf: 16,
  essaisParPlan: 3,
  empecherVeille: true,
  voixAvantRendus: true,             // les voix (courtes) passent avant les rendus 3D
  // ---- création avec Claude ----
  modeleClaude: 'claude-opus-5-5',
  ligneEditoriale: 'Vidéos verticales de 30 secondes qui expliquent simplement un phénomène surprenant du quotidien, de la science ou une histoire vraie. Accroche forte dès la première seconde, une idée par plan, ton direct et chaleureux, rien de faux.',
  langue: 'français',
  categories: ['Et si…', 'Histoires vraies', 'Ton corps', 'Espace', 'Expériences', 'Tech du quotidien'],
  modeCreation: 'avis',              // « avis » : je valide le texte avant la suite ; « auto » : l'IA fait tout
  apprendre: true,                   // garder mes remarques et s'en servir pour les vidéos suivantes
  dureeCible: 30,                    // secondes
  commandeVoix: 'python voix.py {texte} 3 {ep} --ref {voix}',
  voixParDefaut: '',                 // fichier de référence (vide = celle mise en avant)
  publication: { outil: 'metricool', jeton: '', compte: '' },
};
function lireConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(FICHIER_CONFIG, 'utf8')); } catch (e) { /* première fois */ }
  return Object.assign({}, DEFAUT, c);
}
// La file de tâches : celle des réglages, sinon le dépôt qui contient l'application.
function source(config = lireConfig()) {
  if (process.env.ROUAGES_ATELIER) return { type: 'git', chemin: process.env.ROUAGES_ATELIER };
  if (config.source && config.source.chemin) return config.source;
  if (DANS_UN_DEPOT) return { type: fs.existsSync(path.join(DEPOT_PARENT, '.git')) ? 'git' : 'dossier', chemin: DEPOT_PARENT };
  return null;
}
function dossierTravail(config = lireConfig()) {
  return config.dossierTravail || path.join(DONNEES, 'travail');
}
function ecrireConfig(c) {
  const propre = {};
  for (const k of Object.keys(DEFAUT)) if (c[k] !== undefined) propre[k] = c[k];
  ecrireJson(FICHIER_CONFIG, Object.assign({}, lireConfig(), propre));
}

function ecrireJson(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}
function lireJson(f, defaut) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return defaut; }
}

// ---------- journal ----------
const FICHIER_JOURNAL = path.join(DONNEES, 'journal.txt');
const memoireJournal = [];
function heure() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function journal(msg) {
  const ligne = `[${heure()}] ${msg}`;
  memoireJournal.push(ligne);
  if (memoireJournal.length > 400) memoireJournal.splice(0, memoireJournal.length - 400);
  try {
    // on garde le fichier sous ~2 Mo
    try { if (fs.statSync(FICHIER_JOURNAL).size > 2e6) fs.renameSync(FICHIER_JOURNAL, FICHIER_JOURNAL + '.ancien'); } catch (e) { /* rien */ }
    fs.appendFileSync(FICHIER_JOURNAL, ligne + '\n', 'utf8');
  } catch (e) { /* rien */ }
  console.log(ligne);
}

// ---------- programmes ----------
// Lance une commande et rend { code, sortie, erreur } (sortie en texte UTF-8, ou Buffer si binaire).
function executer(prog, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(prog, args, {
      cwd: opts.cwd, env: Object.assign({}, process.env, opts.env || {}),
      encoding: opts.binaire ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024,
      timeout: opts.delai || 0, windowsHide: true,
    }, (err, sortie, erreur) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, sortie, erreur: String(erreur || (err && err.message) || '') });
    });
  });
}

// Lance un programme long (Blender, voix) dont on lit la sortie ligne par ligne.
function lancerLong(prog, args, opts, surLigne) {
  const enfant = spawn(prog, args, {
    cwd: opts.cwd, env: Object.assign({}, process.env, opts.env || {}),
    windowsHide: true, detached: !WINDOWS,
  });
  const lire = (flux) => {
    let reste = '';
    flux.setEncoding('utf8');
    flux.on('data', (morceau) => {
      reste += morceau;
      const lignes = reste.split(/\r?\n|\r/);
      reste = lignes.pop();
      for (const l of lignes) if (l.trim()) surLigne(l);
    });
  };
  lire(enfant.stdout); lire(enfant.stderr);
  const fin = new Promise((resolve) => {
    enfant.on('error', (e) => resolve({ code: -1, erreur: e.message }));
    enfant.on('close', (code, signal) => resolve({ code: code === null ? -1 : code, signal }));
  });
  return { enfant, fin };
}

// Arrête un programme et tous ses sous-programmes, tout de suite.
async function tuerArbre(pid) {
  if (!pid) return;
  if (WINDOWS) await executer('taskkill', ['/PID', String(pid), '/T', '/F']);
  else { try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* déjà fini */ } } }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function sansAccents(t) {
  return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘]/g, "'");
}

module.exports = {
  WINDOWS, ICI, DONNEES, source, dossierTravail, lireConfig, ecrireConfig, ecrireJson, lireJson,
  journal, memoireJournal, executer, lancerLong, tuerArbre, dormir, sansAccents,
};
