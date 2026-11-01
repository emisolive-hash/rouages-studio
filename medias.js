// Médias : liste des vidéos et voix rangées dans pc-vers-cloud, lecture dans le menu, ouverture avec Windows.
'use strict';
const fs = require('fs');
const path = require('path');
const { source, WINDOWS, lireConfig, ecrireConfig, lireJson, DONNEES, ICI, executer } = require('./commun');
const { dossierVoix } = require('./taches/voix');

// « a/… » = <file de tâches>\pc-vers-cloud, « v/… » = dossier des voix (références)
function racines() {
  const src = source();
  return { a: src ? path.join(src.chemin, 'pc-vers-cloud') : '', v: dossierVoix(lireConfig()) };
}

// chemin relatif « a/ep30-final/ep30-plan1.mp4 » -> chemin réel, sans jamais sortir de la racine
function resoudre(rel) {
  const m = String(rel || '').match(/^([av])\/(.+)$/);
  if (!m) return null;
  const base = racines()[m[1]];
  if (!base) return null;
  const racine = path.resolve(base);
  const p = path.resolve(racine, ...m[2].split('/'));
  if (p !== racine && !p.startsWith(racine + path.sep)) return null;
  return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

// envoie un fichier au navigateur, avec reprise (Range) pour pouvoir avancer dans une vidéo
function servirFichier(req, res, p) {
  const taille = fs.statSync(p).size;
  const type = TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) {
    let debut = r[1] ? Number(r[1]) : taille - Number(r[2]);
    let fin = r[1] && r[2] ? Number(r[2]) : taille - 1;
    debut = Math.max(0, debut); fin = Math.min(taille - 1, fin);
    if (debut > fin) { res.writeHead(416, { 'Content-Range': `bytes */${taille}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': fin - debut + 1, 'Content-Range': `bytes ${debut}-${fin}/${taille}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(p, { start: debut, end: fin }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': taille, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  }
}

function noms() {
  const src = source();
  return lireJson(path.join(DONNEES, 'noms.json'), null) || (src && lireJson(path.join(src.chemin, 'noms.json'), null)) || {};
}

// tous les épisodes livrés : vidéos (plans) et voix (prises)
function lister() {
  const base = racines().a;
  const n = noms();
  const parEp = new Map();
  let dossiers = [];
  try { dossiers = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { return []; }
  for (const d of dossiers) {
    const m = d.match(/^(ep\d+)/i);
    if (!m) continue;
    const ep = m[1].toLowerCase();
    let fichiers = [];
    try { fichiers = fs.readdirSync(path.join(base, d)); } catch (e) { continue; }
    for (const f of fichiers) {
      const ext = path.extname(f).toLowerCase();
      if (!['.mp4', '.mp3', '.wav'].includes(ext)) continue;
      const st = fs.statSync(path.join(base, d, f));
      if (!parEp.has(ep)) parEp.set(ep, { ep, nom: n[ep] || ep, videos: [], voix: [], date: 0 });
      const e = parEp.get(ep);
      const item = { nom: f, chemin: `a/${d}/${f}`, dossier: d, taille: st.size, date: st.mtimeMs };
      if (ext === '.mp4') {
        const k = f.match(/plan(\d+)/i);
        item.titre = k ? `Plan ${k[1]}` : f.replace(/\.mp4$/i, '');
        item.ordre = k ? Number(k[1]) : 99;
        e.videos.push(item);
      } else {
        const k = f.match(/prise(\d+)/i);
        item.titre = (k ? `Prise ${k[1]}` : f.replace(/\.(mp3|wav)$/i, '')) + (/-v\d+$/i.test(d) ? ` (${d.match(/v\d+$/i)[0]})` : '');
        // la version la plus récente (v2…) d'abord, puis prise 1, 2, 3
        item.ordre = -(/-v(\d+)$/i.test(d) ? Number(d.match(/-v(\d+)$/i)[1]) : 1) * 100 + (k ? Number(k[1]) : 9);
        e.voix.push(item);
      }
      e.date = Math.max(e.date, st.mtimeMs);
    }
  }
  const liste = [...parEp.values()];
  for (const e of liste) {
    e.videos.sort((a, b) => a.ordre - b.ordre);
    e.voix.sort((a, b) => a.ordre - b.ordre);
  }
  return liste.sort((a, b) => Number(b.ep.slice(2)) - Number(a.ep.slice(2)));
}

// voix de référence disponibles (pour l'onglet Voix)
function voixDisponibles() {
  const d = racines().v;
  let f = [];
  try { f = fs.readdirSync(d).filter((x) => /^reference.*\.(wav|mp3)$/i.test(x)); } catch (e) { /* pas de dossier */ }
  // les voix retirées par l'utilisateur n'apparaissent plus nulle part (le fichier n'est pas touché)
  const masquees = lireConfig().voixMasquees || [];
  f = f.filter((x) => !masquees.includes(x));
  // la voix de référence choisie dans les réglages, sinon la première trouvée
  const pref = lireConfig().voixReference;
  const choisie = (f.includes(pref) && pref) || f.find((x) => /hd/i.test(x)) || f[0];
  return f.map((x) => ({ nom: x, chemin: `v/${x}`, officielle: x === choisie }));
}

// retire (ou remet) une voix dans les listes
function masquerVoix(nom, masquer) {
  const c = lireConfig();
  const l = new Set(c.voixMasquees || []);
  if (masquer) l.add(String(nom)); else if (nom === '*') l.clear(); else l.delete(String(nom));
  const o = { voixMasquees: [...l] };
  if (masquer && c.voixReference === nom) o.voixReference = '';
  if (masquer && c.voixParDefaut === nom) o.voixParDefaut = '';
  ecrireConfig(o);
  return o.voixMasquees.length;
}

function ouvrir(rel) {
  const p = resoudre(rel);
  if (!p) return false;
  if (WINDOWS) executer('explorer.exe', [p]);
  return true;
}

module.exports = { lister, resoudre, servirFichier, ouvrir, voixDisponibles, masquerVoix };
