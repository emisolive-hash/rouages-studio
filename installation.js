// Premier lancement : vérification des logiciels, choix des dossiers, file de tâches, clé Claude.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { WINDOWS, ICI, DONNEES, lireConfig, ecrireConfig, source, dossierTravail, executer, journal } = require('./commun');
const { trouverBlender, trouverFfmpeg } = require('./taches/blender');
const { trouverPython, dossierVoix } = require('./taches/voix');

// Logiciels utiles, avec leur identifiant winget (installation en un clic sous Windows).
const LOGICIELS = {
  node: { nom: 'Node.js', winget: 'OpenJS.NodeJS.LTS', role: "fait tourner l'application", obligatoire: true },
  git: { nom: 'Git', winget: 'Git.Git', role: 'récupère les tâches et envoie les vidéos (file sur GitHub)', obligatoire: false },
  blender: { nom: 'Blender', winget: 'BlenderFoundation.Blender', role: 'rend les scènes 3D', obligatoire: true },
  ffmpeg: { nom: 'ffmpeg', winget: 'Gyan.FFmpeg', role: 'assemble les images en vidéo MP4', obligatoire: true },
  python: { nom: 'Python', winget: 'Python.Python.3.12', role: 'génère les voix (facultatif)', obligatoire: false },
};

async function version(prog, args) {
  const r = await executer(prog, args, { delai: 20000 });
  if (r.code !== 0) return null;
  return String(r.sortie || r.erreur).split('\n').find((l) => l.trim()) || 'installé';
}

async function diagnostic() {
  const config = lireConfig();
  const blender = trouverBlender(config);
  const res = {};
  res.node = { ok: true, version: process.version, chemin: process.execPath };
  const g = await version('git', ['--version']);
  res.git = { ok: !!g, version: g };
  // blender --version est lent : on se contente de voir si le programme existe
  const bOk = WINDOWS ? (path.isAbsolute(blender) ? fs.existsSync(blender) : !!(await version('where', [blender]))) : !!(await version(blender, ['--version']));
  res.blender = { ok: bOk, chemin: bOk ? blender : '' };
  const f = await version(trouverFfmpeg(config), ['-version']);
  res.ffmpeg = { ok: !!f, version: f ? f.split(' ').slice(0, 3).join(' ') : null };
  const py = trouverPython(config);
  const p = await version(py, ['--version']);
  res.python = { ok: !!p, version: p };
  for (const k of Object.keys(res)) Object.assign(res[k], LOGICIELS[k]);
  return {
    logiciels: res,
    windows: WINDOWS,
    dossierApp: ICI,
    donnees: DONNEES,
    source: source(config),
    travail: dossierTravail(config),
    dossierVoix: dossierVoix(config),
    cleClaude: !!config.cleClaude,
    premierLancementFait: !!config.premierLancementFait,
  };
}

// Fenêtre Windows « Choisir un dossier ». Rend le chemin choisi, ou '' si annulé / pas sous Windows.
async function choisirDossier(titre) {
  if (!WINDOWS) return '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = '${String(titre || 'Choisis un dossier').replace(/'/g, "''")}'`,
    '$d.ShowNewFolderButton = $true',
    '$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}',
    'if ($d.ShowDialog($f) -eq "OK") { [Console]::OutputEncoding=[Text.Encoding]::UTF8; $d.SelectedPath }',
  ].join('; ');
  const r = await executer('powershell', ['-NoProfile', '-STA', '-Command', script], { delai: 600000 });
  return (r.sortie || '').trim();
}

// Ouvre une console qui installe le logiciel avec winget (l'utilisateur voit tout et peut annuler).
async function installer(cle) {
  const l = LOGICIELS[cle];
  if (!l) throw new Error('logiciel inconnu');
  if (!WINDOWS) throw new Error("l'installation automatique est prévue pour Windows (winget)");
  journal(`Installation de ${l.nom} (winget ${l.winget}).`);
  await executer('cmd', ['/c', 'start', `Installation de ${l.nom}`, 'cmd', '/k',
    `winget install -e --id ${l.winget} --accept-source-agreements --accept-package-agreements && echo. && echo Termine : tu peux fermer cette fenetre et cliquer sur "Verifier" dans Rouages Studio.`]);
  return true;
}

// Vérifie une clé API Claude en listant les modèles (aucun coût).
function testerCle(cle) {
  return new Promise((resolve) => {
    if (!/^sk-ant-[\w-]{10,}$/.test(String(cle || '').trim())) return resolve({ ok: false, erreur: 'La clé doit commencer par « sk-ant- ».' });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/models?limit=1', method: 'GET', timeout: 15000,
      headers: { 'x-api-key': cle.trim(), 'anthropic-version': '2023-06-01' },
    }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve({ ok: true });
      else if (res.statusCode === 401) resolve({ ok: false, erreur: 'Clé refusée par Anthropic (vérifie-la).' });
      else resolve({ ok: false, erreur: `Réponse inattendue d'Anthropic (${res.statusCode}).` });
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', (e) => resolve({ ok: false, erreur: `Pas de connexion à Anthropic : ${e.message}` }));
    req.end();
  });
}

async function enregistrerCle(cle) {
  if (!cle) { ecrireConfig({ cleClaude: '' }); journal('Clé Claude retirée.'); return { ok: true }; }
  const t = await testerCle(cle);
  // on l'enregistre même si le test réseau échoue (hors ligne), mais pas si elle est refusée
  if (t.ok || !/refusée|sk-ant/.test(t.erreur || '')) { ecrireConfig({ cleClaude: cle.trim() }); journal('Clé Claude enregistrée sur ce PC.'); }
  return t;
}

function cheminSur(p) {
  const s = String(p || '').trim().replace(/^"|"$/g, '');
  if (!s || s.startsWith('-') || !path.isAbsolute(s)) throw new Error('Chemin invalide : donne un chemin complet (ex. C:\\Users\\toi\\Documents\\Rouages).');
  return path.normalize(s);
}

// Configure la file de tâches.
// mode « cloner » : { url, parent } -> git clone dans parent ; « existant » : { chemin } ; « local » : { chemin } (dossier simple, créé si besoin)
async function configurerSource(d) {
  let src;
  if (d.mode === 'cloner') {
    const url = String(d.url || '').trim();
    if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(url)) throw new Error("Adresse du dépôt invalide (elle commence par https:// ou git@).");
    const parent = cheminSur(d.parent);
    fs.mkdirSync(parent, { recursive: true });
    const nom = (url.split('/').pop() || 'file-rouages').replace(/\.git$/, '') || 'file-rouages';
    const cible = path.join(parent, nom);
    if (!fs.existsSync(path.join(cible, '.git'))) {
      journal(`Copie du dépôt ${url} dans ${cible}…`);
      const r = await executer('git', ['clone', '--', url, cible], { delai: 900000 });
      if (r.code !== 0) throw new Error(`git clone a échoué : ${r.erreur.trim().split('\n').pop()}`);
    }
    src = { type: 'git', chemin: cible };
  } else if (d.mode === 'existant' || d.mode === 'local') {
    const chemin = cheminSur(d.chemin);
    const estGit = fs.existsSync(path.join(chemin, '.git'));
    if (d.mode === 'existant' && !fs.existsSync(chemin)) throw new Error("Ce dossier n'existe pas.");
    if (!estGit) {
      fs.mkdirSync(path.join(chemin, 'cloud-vers-pc'), { recursive: true });
      fs.mkdirSync(path.join(chemin, 'pc-vers-cloud'), { recursive: true });
    }
    src = { type: estGit ? 'git' : 'dossier', chemin };
  } else if (d.mode === 'aucune') {
    src = null;
  } else throw new Error('mode inconnu');
  ecrireConfig({ source: src });
  journal(src ? `File de tâches : ${src.chemin} (${src.type === 'git' ? 'dépôt git' : 'dossier local'}).` : 'File de tâches retirée.');
  return src;
}

function configurerTravail(chemin) {
  if (!chemin) { ecrireConfig({ dossierTravail: '' }); return dossierTravail(lireConfig()); }
  const p = cheminSur(chemin);
  fs.mkdirSync(p, { recursive: true });
  ecrireConfig({ dossierTravail: p });
  return p;
}

module.exports = { diagnostic, choisirDossier, installer, testerCle, enregistrerCle, configurerSource, configurerTravail, LOGICIELS };
