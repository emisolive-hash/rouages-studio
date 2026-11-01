// Rendu d'UN plan 3D avec Blender, reprise à l'image près, encodage MP4, envoi dans pc-vers-cloud.
'use strict';
const fs = require('fs');
const path = require('path');
const { WINDOWS, ICI, executer, lancerLong, journal } = require('../commun');
const { livrer } = require('../atelier-git');

// Cherche blender.exe (la version la plus récente de C:\Program Files\Blender Foundation).
function trouverBlender(config) {
  if (config.blender) return config.blender;
  if (!WINDOWS) return 'blender';
  const bases = [process.env.ProgramFiles || 'C:\\Program Files', 'C:\\Program Files'];
  for (const base of bases) {
    const racine = path.join(base, 'Blender Foundation');
    try {
      const versions = fs.readdirSync(racine).filter((d) => /^Blender/i.test(d))
        .sort((a, b) => (b.match(/[\d.]+/) || ['0'])[0].localeCompare((a.match(/[\d.]+/) || ['0'])[0], undefined, { numeric: true }));
      for (const v of versions) { const exe = path.join(racine, v, 'blender.exe'); if (fs.existsSync(exe)) return exe; }
    } catch (e) { /* pas là */ }
  }
  return 'blender';
}

function trouverFfmpeg(config) {
  if (config.ffmpeg) return config.ffmpeg;
  if (WINDOWS && process.env.LOCALAPPDATA) {
    const lien = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    if (fs.existsSync(lien)) return lien;
  }
  return 'ffmpeg';
}

// Une image PNG coupée en plein milieu (PC éteint, Blender arrêté pendant l'écriture) ne finit pas par IEND :
// on la supprime pour qu'elle soit refaite.
function nettoyerImages(dossier) {
  let supprimees = 0;
  if (!fs.existsSync(dossier)) return 0;
  for (const f of fs.readdirSync(dossier)) {
    if (!/\.png$/i.test(f)) continue;
    const p = path.join(dossier, f);
    try {
      const taille = fs.statSync(p).size;
      let ok = taille > 100;
      if (ok) {
        const fd = fs.openSync(p, 'r');
        const b = Buffer.alloc(12);
        fs.readSync(fd, b, 0, 12, taille - 12);
        fs.closeSync(fd);
        ok = b.toString('latin1', 4, 8) === 'IEND';
      }
      if (!ok) { fs.unlinkSync(p); supprimees++; }
    } catch (e) { /* ignorée */ }
  }
  return supprimees;
}

function imagesDuPlan(dossier, prefixe) {
  if (!fs.existsSync(dossier)) return [];
  const re = new RegExp('^' + prefixe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)\\.png$', 'i');
  return fs.readdirSync(dossier).map((f) => { const m = f.match(re); return m ? { f, n: Number(m[1]), chiffres: m[1].length } : null; })
    .filter(Boolean).sort((a, b) => a.n - b.n);
}

// ctx : { tache, travail, config, suivi (objet d'état partagé), controle: { arreter: bool, enfant } }
async function rendrePlan(ctx, plan) {
  const { tache: t, travail, config, suivi } = ctx;
  const src = path.join(travail, 'src');
  const dossierImages = path.join(travail, 'rendu', `p${plan}`);
  const prefixe = `${t.ep}_p${plan}_`;
  fs.mkdirSync(dossierImages, { recursive: true });
  const meta = ctx.meta;
  meta.plans = meta.plans || {};
  const mp = meta.plans[plan] = meta.plans[plan] || { secondes: 0, essais: 0 };

  const abimees = nettoyerImages(dossierImages);
  if (abimees) journal(`${t.ep} plan ${plan} : ${abimees} image(s) incomplète(s) supprimée(s), elles seront refaites.`);

  const blender = trouverBlender(config);
  const deja = imagesDuPlan(dossierImages, prefixe).length;
  Object.assign(suivi, {
    etape: `Rendu Blender, plan ${plan} sur ${t.plans}`, plan, images: deja, total: mp.total || 0,
    debutPlan: Date.now(), secondesParImage: mp.total && mp.secondes && deja ? mp.secondes / deja : 0, derniereLigne: '',
  });
  journal(`${t.ep} plan ${plan} : lancement de Blender${deja ? ` (reprise, ${deja} image(s) déjà faites)` : ''}.`);

  const debut = Date.now();
  let imagesSession = 0;
  // nombre d'images faites + dernière image (aperçu en direct dans le menu)
  function majImages() {
    const l = imagesDuPlan(dossierImages, prefixe);
    suivi.images = l.length;
    suivi.derniereImage = l.length ? path.join(dossierImages, l[l.length - 1].f) : null;
  }
  majImages();
  let plantageGpu = false;
  if (meta.cuda) journal(`${t.ep} plan ${plan} : rendu en CUDA (le GPU avait planté en OptiX).`);
  const { enfant, fin } = lancerLong(blender, [
    '-b', '--python-exit-code', '1', '-P', path.join(ICI, 'lanceur_blender.py'), '--',
    '--plan', String(plan), '--sortie', path.join(dossierImages, prefixe),
  ], { cwd: src, env: Object.assign({ ROUAGES_SCENE: path.join(src, t.script) }, meta.cuda ? { ROUAGES_PERIPHERIQUE: 'CUDA' } : {}) }, (ligne) => {
    let m;
    if ((m = ligne.match(/^ROUAGES_PLAGE (\d+) (\d+)/))) { mp.total = Number(m[2]) - Number(m[1]) + 1; suivi.total = mp.total; return; }
    if ((m = ligne.match(/^ROUAGES_IMAGE (\d+)/))) {
      imagesSession++;
      majImages();
      const ecoule = (Date.now() - debut) / 1000;
      suivi.secondesParImage = ecoule / imagesSession;
      return;
    }
    // plantage du GPU (OptiX/CUDA « illegal address », erreur 700) : la suite de cette vidéo passera en CUDA
    if (/illegal address|CUDA error|OPTIX_ERROR|error 700|out of GPU|shared host memory|out of memory/i.test(ligne)) plantageGpu = true;
    if (/^ROUAGES_INFO/.test(ligne)) journal(`${t.ep} plan ${plan} : ${ligne.slice(13)}`);
    if (/^Fra:|^ROUAGES_/.test(ligne)) return;
    suivi.derniereLigne = ligne.slice(0, 200);
    if (/error|erreur|traceback|exception/i.test(ligne)) journal(`Blender : ${ligne.slice(0, 300)}`);
  });
  ctx.controle.enfant = enfant;
  // compteur d'images de secours (si Blender ne parle pas)
  const minuterie = setInterval(majImages, 3000);
  const r = await fin;
  clearInterval(minuterie);
  ctx.controle.enfant = null;
  mp.secondes += (Date.now() - debut) / 1000;
  ctx.sauverMeta();

  if (ctx.controle.arreter) return { pause: true };

  const images = imagesDuPlan(dossierImages, prefixe);
  suivi.images = images.length;
  if (r.code !== 0 || !images.length || (mp.total && images.length < mp.total)) {
    mp.essais++;
    ctx.sauverMeta();
    const raison = r.code === -1 && r.erreur ? `Blender introuvable (${blender})` : `Blender s'est arrêté (code ${r.code}), ${images.length}/${mp.total || '?'} images`;
    if (plantageGpu) {
      const avant = meta.cuda;
      meta.cuda = true; ctx.sauverMeta();
      return { erreur: `${raison} : plantage du GPU${avant ? '' : ', nouvel essai en CUDA'} après une pause pour le laisser refroidir`, gpu: true, bascule: !avant };
    }
    return { erreur: raison };
  }

  // ---------- encodage MP4 ----------
  suivi.etape = `Encodage MP4, plan ${plan}`;
  const mp4 = path.join(travail, `${t.ep}-plan${plan}.mp4`);
  const chiffres = images[0].chiffres;
  const ffmpeg = trouverFfmpeg(config);
  let crf = Number(config.crf) || 16;
  for (;;) {
    const e = await executer(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '30', '-start_number', String(images[0].n),
      '-i', path.join(dossierImages, `${prefixe}%0${chiffres}d.png`),
      '-frames:v', String(images.length), '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    if (e.code !== 0) return { erreur: `ffmpeg a échoué : ${e.erreur.trim().split('\n').pop() || 'ffmpeg introuvable'}` };
    if (fs.statSync(mp4).size < 95e6 || crf >= 30) break;
    crf += 4;   // trop gros pour GitHub : on compresse un peu plus
  }

  // ---------- envoi ----------
  suivi.etape = `Envoi du plan ${plan}`;
  const sec = Math.round(mp.secondes);
  const ligneTemps = `plan ${plan} : ${images.length} images en ${sec} s (${(sec / images.length).toFixed(1)} s/image), total ${images.length}, essai ${mp.essais + 1}, menu`;
  await livrer(t.sortie, [{ source: mp4, nom: `${t.ep}-plan${plan}.mp4` }], [{ nom: 'temps.txt', texte: ligneTemps }],
    `${t.ep} : plan ${plan} rendu (${images.length} images, ${(sec / images.length).toFixed(1)} s/image)`);
  mp.livre = true;
  ctx.sauverMeta();
  return { ok: true, images: images.length, secondes: sec, medias: [`a/${t.sortie}/${t.ep}-plan${plan}.mp4`] };
}

module.exports = { rendrePlan, trouverBlender, trouverFfmpeg, nettoyerImages, imagesDuPlan };
