// La file de tâches : un dépôt git (branches main + claude/*) ou un simple dossier local.
// Dans les deux cas : demandes dans cloud-vers-pc/<dossier>/A-FAIRE.md, résultats dans pc-vers-cloud/<sortie>/.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { executer, journal, dormir, sansAccents, source } = require('./commun');

function racine() {
  const s = source();
  if (!s) throw new Error("aucune file de tâches n'est configurée (ouvre le guide de démarrage)");
  return s;
}
const modeDossier = () => racine().type === 'dossier';

async function git(args, opts = {}) {
  // plusieurs programmes peuvent toucher le dépôt (l'ancienne session Claude, ce menu) :
  // si git est verrouillé, on réessaie un peu plus tard
  for (let essai = 0; essai < 6; essai++) {
    const r = await executer('git', ['-C', racine().chemin, '-c', 'core.quotepath=off', ...args], opts);
    if (r.code !== 0 && /index\.lock|unable to lock|cannot lock ref/i.test(r.erreur)) { await dormir(3000 * (essai + 1)); continue; }
    return r;
  }
  return executer('git', ['-C', racine().chemin, ...args], opts);
}

async function gitOk(args, opts) {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} : ${r.erreur.trim().split('\n').slice(-3).join(' ')}`);
  return r.sortie;
}

async function recuperer() {
  if (modeDossier()) return fs.existsSync(path.join(racine().chemin, 'cloud-vers-pc'));
  for (let essai = 0; essai < 4; essai++) {
    const r = await git(['fetch', 'origin', '--prune', '--quiet'], { delai: 180000 });
    if (r.code === 0) return true;
    journal(`Relève de l'atelier impossible (essai ${essai + 1}) : ${r.erreur.trim().split('\n').pop()}`);
    await dormir(2000 * Math.pow(2, essai));
  }
  return false;
}

async function branches() {
  const s = await gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
  return s.split('\n').map((x) => x.trim())
    .filter((b) => b && b !== 'origin/HEAD' && b !== 'origin' && (b === 'origin/main' || b.startsWith('origin/claude/')));
}

// Nombre de plans d'un rendu 3D : lu dans l'A-FAIRE, sinon dans le dictionnaire NV/N du script.
function nombreDePlans(afaire, script) {
  const t = sansAccents(afaire);
  let m = t.match(/plans?\s+dans\s+l'ordre\s*:?\s*([\d][\d\s,et]*)/i);
  if (m) { const n = m[1].match(/\d+/g).map(Number); if (n.length) return Math.max(...n); }
  m = t.match(/plans?\s+1\s*(?:a|-)\s*(\d+)/i); if (m) return Number(m[1]);
  m = t.match(/ordre\s*:?\s*1\s*(?:a|-)\s*(\d+)/i); if (m) return Number(m[1]);
  m = t.match(/ordre\s*:?\s*((?:\d+\s*(?:,|et)?\s*){2,})/i);
  if (m) { const n = m[1].match(/\d+/g).map(Number); if (n.length) return Math.max(...n); }
  if (script) {
    for (const nom of ['NV', 'N']) {
      const d = script.match(new RegExp('^' + nom + '\\s*=\\s*\\{([^}]*)\\}', 'm'));
      if (d) { const cles = [...d[1].matchAll(/(\d+)\s*:/g)].map((x) => Number(x[1])); if (cles.length) return Math.max(...cles); }
    }
  }
  m = t.match(/(\d+)\s+plans/i); if (m) return Number(m[1]);
  return 0;
}

function bloquee(afaire) {
  return /PAS ENCORE PRET|EN ATTENTE|NE PAS RENDRE|NE RIEN RENDRE/i.test(sansAccents(afaire).toUpperCase());
}

// Regarde toutes les branches et rend la liste des demandes (voix, rendus 3D) avec leur avancement.
async function lireFile(config) {
  if (modeDossier()) return lireFileDossier(config);
  const refs = await branches();
  const limite = config.ignorerAvant ? Date.parse(config.ignorerAvant + 'T00:00:00Z') / 1000 : 0;
  const parDossier = new Map();
  let pauseCloud = false;

  for (const ref of refs) {
    const fichiers = (await git(['ls-tree', '-r', '--name-only', ref, '--', 'cloud-vers-pc'])).sortie || '';
    const liste = fichiers.split('\n').filter(Boolean);
    if (liste.includes('cloud-vers-pc/PAUSE')) pauseCloud = true;
    // date du dernier changement de chaque dossier (une seule commande git par branche)
    const histo = (await git(['log', '--format=@@%ct', '--name-only', ref, '--', 'cloud-vers-pc'])).sortie || '';
    const dates = new Map();
    let quand = 0;
    for (const l of histo.split('\n')) {
      if (l.startsWith('@@')) { quand = Number(l.slice(2)); continue; }
      const m = l.match(/^cloud-vers-pc\/([^/]+)\//);
      if (m && !dates.has(m[1])) dates.set(m[1], quand);
    }
    const arbres = new Map();
    for (const l of ((await git(['ls-tree', ref, 'cloud-vers-pc/'])).sortie || '').split('\n')) {
      const m = l.match(/^\d+ tree ([0-9a-f]+)\tcloud-vers-pc\/(.+)$/);
      if (m) arbres.set(m[2], m[1]);
    }
    for (const f of liste) {
      const m = f.match(/^cloud-vers-pc\/([^/]+)\/A-FAIRE\.md$/);
      if (!m) continue;
      const dossier = m[1];
      const type = typeDe(dossier);
      if (!type) continue;
      const date = dates.get(dossier) || 0;
      if (date < limite) continue;
      const ancien = parDossier.get(dossier);
      if (ancien && ancien.date >= date) continue;
      parDossier.set(dossier, {
        dossier, type, ref, date, arbre: arbres.get(dossier) || '',
        fichiers: liste.filter((x) => x.startsWith(`cloud-vers-pc/${dossier}/`)).map((x) => x.slice(`cloud-vers-pc/${dossier}/`.length)),
      });
    }
  }

  const sorties = new Set(((await git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'pc-vers-cloud'])).sortie || '').split('\n').filter(Boolean));
  const lire = async (t, f) => (await git(['show', `${t.ref}:cloud-vers-pc/${t.dossier}/${f}`])).sortie || '';
  return { taches: await analyser([...parDossier.values()], sorties, lire), pauseCloud };
}

// ---------- mode « dossier local » (sans git) ----------
function lister(base, rel = '') {
  const res = [];
  let entrees = [];
  try { entrees = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) { return res; }
  for (const e of entrees) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) res.push(...lister(base, r));
    else if (e.isFile()) res.push(r);
  }
  return res;
}
async function lireFileDossier(config) {
  const base = racine().chemin;
  const entree = path.join(base, 'cloud-vers-pc');
  const limite = config.ignorerAvant ? Date.parse(config.ignorerAvant + 'T00:00:00Z') / 1000 : 0;
  const pauseCloud = fs.existsSync(path.join(entree, 'PAUSE'));
  const parDossier = [];
  let dossiers = [];
  try { dossiers = fs.readdirSync(entree, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { /* vide */ }
  for (const dossier of dossiers) {
    const type = typeDe(dossier);
    if (!type || !fs.existsSync(path.join(entree, dossier, 'A-FAIRE.md'))) continue;
    const fichiers = lister(path.join(entree, dossier));
    const h = crypto.createHash('sha1');
    let date = 0;
    for (const f of fichiers) {
      const st = fs.statSync(path.join(entree, dossier, ...f.split('/')));
      h.update(`${f}|${st.size}|${st.mtimeMs}\n`);
      date = Math.max(date, Math.floor(st.mtimeMs / 1000));
    }
    if (date < limite) continue;
    parDossier.push({ dossier, type, ref: 'local', date, arbre: h.digest('hex'), fichiers });
  }
  const sorties = new Set(lister(path.join(base, 'pc-vers-cloud')).map((f) => `pc-vers-cloud/${f}`));
  const lire = async (t, f) => { try { return fs.readFileSync(path.join(entree, t.dossier, ...f.split('/')), 'utf8'); } catch (e) { return ''; } };
  return { taches: await analyser(parDossier, sorties, lire), pauseCloud };
}

function typeDe(dossier) {
  return /^ep\d+-(3d|final)$/i.test(dossier) ? '3d' : /^ep\d+-voix(-v\d+)?$/i.test(dossier) ? 'voix' : null;
}

// Lit chaque A-FAIRE.md et en déduit le type de travail, le nombre de plans et ce qui est déjà fait.
async function analyser(liste, sorties, lire) {
  const taches = [];
  for (const t of liste) {
    const afaire = await lire(t, 'A-FAIRE.md');
    t.ep = (t.dossier.match(/^(ep\d+)/i) || [])[1] || t.dossier;
    const sortie = afaire.match(/pc-vers-cloud\/([\w.-]+)\//);
    t.titre = (afaire.split('\n').find((l) => l.startsWith('#')) || t.dossier).replace(/^#+\s*/, '').trim();
    t.afaire = afaire;
    if (t.type === '3d') {
      t.sortie = sortie ? sortie[1] : `${t.ep}-final`;
      const s = afaire.match(/-P\s+([\w.-]+\.py)/);
      t.script = s ? s[1] : (t.fichiers.find((x) => /_scenes\.py$/.test(x)) || '');
      const code = t.script && t.fichiers.includes(t.script) ? await lire(t, t.script) : '';
      t.plans = nombreDePlans(afaire, code);
      t.plansFaits = [];
      for (let k = 1; k <= t.plans; k++) if (sorties.has(`pc-vers-cloud/${t.sortie}/${t.ep}-plan${k}.mp4`)) t.plansFaits.push(k);
      const im = sansAccents(afaire).match(/(\d+)\s+images/i);
      t.imagesPrevues = im ? Number(im[1]) : 0;
      if (bloquee(afaire)) t.statut = 'attente';
      else if (!t.script || !t.fichiers.includes(t.script) || !t.plans) { t.statut = 'illisible'; t.message = 'Script ou nombre de plans introuvable dans A-FAIRE.md'; }
      else if (t.plansFaits.length >= t.plans) t.statut = 'fait';
      else t.statut = 'pret';
    } else {
      t.sortie = sortie ? sortie[1] : t.dossier;
      const c = afaire.match(/python\s+voix\.py\s+([^`\n]+)/i) || afaire.match(/voix\.py\s+([^`\n]+)/i);
      t.argsVoix = c ? c[1].trim().split(/\s+/) : null;
      const fait = [...sorties].some((x) => x.startsWith(`pc-vers-cloud/${t.sortie}/`) && /\.(mp3|wav)$/i.test(x));
      if (fait) t.statut = 'fait';
      else if (bloquee(afaire)) t.statut = 'attente';
      else if (!t.argsVoix || t.argsVoix.length < 3 || !t.fichiers.includes(t.argsVoix[0])) { t.statut = 'illisible'; t.message = 'Commande voix.py ou texte introuvable dans A-FAIRE.md'; }
      else t.statut = 'pret';
    }
    taches.push(t);
  }
  taches.sort((a, b) => a.date - b.date);
  return taches;
}

// Copie le dossier de la demande depuis git vers le dossier de travail (sans toucher au dossier atelier).
async function extraire(t, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (modeDossier()) {
    for (const f of t.fichiers) {
      const cible = path.join(dest, ...f.split('/'));
      fs.mkdirSync(path.dirname(cible), { recursive: true });
      fs.copyFileSync(path.join(racine().chemin, 'cloud-vers-pc', t.dossier, ...f.split('/')), cible);
    }
    return;
  }
  for (const f of t.fichiers) {
    const r = await git(['show', `${t.ref}:cloud-vers-pc/${t.dossier}/${f}`], { binaire: true });
    if (r.code !== 0) throw new Error(`impossible de lire ${f} : ${r.erreur.trim()}`);
    const cible = path.join(dest, ...f.split('/'));
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.writeFileSync(cible, r.sortie);
  }
}

// Pousse des fichiers dans pc-vers-cloud/<dossier>/ sur main, en un commit.
// fichiers : [{ source, nom }] ; ajouts : [{ nom, texte }] ajouté à la fin d'un fichier texte (temps.txt).
function ecrireSortie(cible, fichiers, ajouts) {
  fs.mkdirSync(cible, { recursive: true });
  const noms = [];
  for (const f of fichiers) { fs.copyFileSync(f.source, path.join(cible, f.nom)); noms.push(f.nom); }
  for (const a of ajouts || []) {
    const fa = path.join(cible, a.nom);
    noms.push(a.nom);
    if (a.remplacer) { fs.writeFileSync(fa, a.texte, 'utf8'); continue; }
    const avant = fs.existsSync(fa) ? fs.readFileSync(fa, 'utf8') : '';
    const lignes = avant.split('\n').filter((l) => l.trim());
    // une seule ligne par plan : on remplace l'ancienne ligne du même plan si elle existe
    const cle = a.texte.split(':')[0].trim();
    const reste = lignes.filter((l) => l.split(':')[0].trim() !== cle);
    fs.writeFileSync(fa, [...reste, a.texte].join('\n') + '\n', 'utf8');
  }
  return noms;
}

async function livrer(dossier, fichiers, ajouts, message) { return envoyer('pc-vers-cloud', dossier, fichiers, ajouts, message); }
// Dépose une nouvelle demande dans cloud-vers-pc/<dossier>/ (création de vidéo depuis l'app).
async function deposer(dossier, fichiers, message) { return envoyer('cloud-vers-pc', dossier, [], fichiers.map((f) => ({ nom: f.nom, texte: f.texte, remplacer: true })), message); }

async function envoyer(base, dossier, fichiers, ajouts, message) {
  const cible = path.join(racine().chemin, base, dossier);
  if (modeDossier()) { ecrireSortie(cible, fichiers, ajouts); journal(`Rangé dans ${base} : ${message}`); return true; }
  const branche = (await gitOk(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (branche !== 'main') throw new Error(`le dépôt de la file est sur la branche « ${branche} » au lieu de main`);
  for (let essai = 0; essai < 5; essai++) {
    const p = await git(['pull', '--rebase', '--autostash', '--quiet', 'origin', 'main'], { delai: 300000 });
    if (p.code !== 0) { journal(`git pull : ${p.erreur.trim().split('\n').pop()}`); await git(['rebase', '--abort']); }
    const chemins = ecrireSortie(cible, fichiers, ajouts).map((n) => [base, dossier, n].filter(Boolean).join('/'));
    await gitOk(['add', '--', ...chemins]);
    const c = await git(['commit', '-m', message, '--', ...chemins]);
    if (c.code !== 0 && !/nothing to commit|rien à valider/i.test(c.sortie + c.erreur)) throw new Error(`git commit : ${c.erreur.trim() || c.sortie.trim()}`);
    const r = await git(['push', 'origin', 'HEAD:main'], { delai: 600000 });
    if (r.code === 0) { journal(`Envoyé sur l'atelier : ${message}`); return true; }
    journal(`Envoi refusé (essai ${essai + 1}), nouvel essai : ${r.erreur.trim().split('\n').pop()}`);
    await dormir(2000 * Math.pow(2, essai));
  }
  throw new Error("impossible d'envoyer sur le dépôt (réseau ?). Le fichier est gardé, il repartira au prochain essai.");
}

module.exports = { recuperer, lireFile, extraire, livrer, deposer, envoyer, nombreDePlans, git, modeDossier };
