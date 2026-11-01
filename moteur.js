// Le moteur : relève la file de tâches, lance les tâches une par une, gère pause et reprise.
'use strict';
const fs = require('fs');
const path = require('path');
const { WINDOWS, DONNEES, source, dossierTravail, lireConfig, ecrireJson, lireJson, journal, executer, tuerArbre, dormir } = require('./commun');
const atelier = require('./atelier-git');
const { rendrePlan, trouverBlender, trouverFfmpeg } = require('./taches/blender');
const { genererVoix, trouverPython, dossierVoix } = require('./taches/voix');

const FICHIER_ETAT = path.join(DONNEES, 'etat.json');
const { ICI } = require('./commun');

// nom lisible d'un épisode : noms.json (réglable), sinon le titre de l'A-FAIRE nettoyé
function nomEpisode(t) {
  // noms.json : dans les données de l'app, sinon à la racine de la file de tâches
  const src = source();
  const noms = lireJson(path.join(DONNEES, 'noms.json'), null) || (src && lireJson(path.join(src.chemin, 'noms.json'), null)) || {};
  if (noms[t.ep]) return noms[t.ep];
  let n = String(t.titre || '');
  const g = n.match(/«\s*([^»]+?)\s*»/);
  if (g) return g[1];
  n = n.replace(/^ep\d+\s*:?\s*/i, '').replace(/^3D\s*:?\s*/i, '').replace(/PR[EÊ]T [AÀ] RENDRE/gi, '')
    .replace(/\([^)]*\)/g, '').replace(/^[\s:—-]+|[\s:—-]+$/g, '');
  return n.length > 2 ? n.charAt(0).toUpperCase() + n.slice(1) : t.ep;
}

class Moteur {
  constructor() {
    const e = lireJson(FICHIER_ETAT, {});
    this.enMarche = e.enMarche === undefined ? true : !!e.enMarche;   // reprend comme on l'avait laissé
    this.pauseFinPlan = !!e.pauseFinPlan;
    this.ignores = e.ignores || [];
    this.priorites = e.priorites || [];
    this.historique = e.historique || [];
    this.erreurs = e.erreurs || {};
    this.pauseCloudSignalee = !!e.pauseCloudSignalee;
    this.etat = 'demarrage';
    this.taches = [];
    this.pauseCloud = false;
    this.derniereReleve = 0;
    this.releveDemandee = true;
    this.enCours = null;
    this.suivi = {};
    this.controle = { arreter: false, enfant: null };
    this.occupePar = null;
    this.messageGit = '';
    this._reveil = null;
    this._veille = null;
  }

  sauver() {
    ecrireJson(FICHIER_ETAT, {
      enMarche: this.enMarche, pauseFinPlan: this.pauseFinPlan, ignores: this.ignores, priorites: this.priorites,
      historique: this.historique.slice(-60), erreurs: this.erreurs, pauseCloudSignalee: this.pauseCloudSignalee,
    });
  }

  reveiller() { if (this._reveil) this._reveil(); }
  attendre(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._reveil = null; resolve(); }, ms);
      this._reveil = () => { clearTimeout(t); this._reveil = null; resolve(); };
    });
  }

  // ---------- empêcher la mise en veille de Windows pendant le travail ----------
  veille(active) {
    const config = lireConfig();
    if (!WINDOWS || !config.empecherVeille) return;
    if (active && !this._veille) {
      const { spawn } = require('child_process');
      const ps = '$s=\'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);\';' +
        '$k=Add-Type -MemberDefinition $s -Name Veille -Namespace Rouages -PassThru;' +
        'while($true){ [void]$k::SetThreadExecutionState([uint32]2147483649); Start-Sleep -Seconds 30 }';
      this._veille = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
      this._veille.on('error', () => { this._veille = null; });
    } else if (!active && this._veille) {
      tuerArbre(this._veille.pid);
      this._veille = null;
    }
  }

  // ---------- autre programme qui utilise déjà le GPU (ancienne session Claude, Blender ouvert à la main) ----------
  async autreProgramme() {
    if (!WINDOWS) return null;
    const r = await executer('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/FO', 'CSV', '/NH']);
    const pids = [...(r.sortie || '').matchAll(/"blender\.exe","(\d+)"/gi)].map((m) => Number(m[1]));
    if (pids.length) return { quoi: 'Blender', pids };
    const v = await executer('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Where-Object { $_.CommandLine -like '*voix.py*' } | ForEach-Object { $_.ProcessId }"], { delai: 30000 });
    const vp = (v.sortie || '').split(/\s+/).filter(Boolean).map(Number);
    if (vp.length) return { quoi: 'une génération de voix (voix.py)', pids: vp };
    return null;
  }

  // ---------- relève ----------
  async relever() {
    const config = lireConfig();
    if (!source(config)) { this.etat = 'configuration'; this.taches = []; this.releveDemandee = false; this.derniereReleve = Date.now(); return; }
    this.etat = this.etat === 'travail' ? 'travail' : 'releve';
    const ok = await atelier.recuperer();
    // met à jour le dépôt local (pour l'onglet Médias) seulement si c'est sans risque (avance rapide)
    if (ok && !atelier.modeDossier() && ((await atelier.git(['rev-parse', '--abbrev-ref', 'HEAD'])).sortie || '').trim() === 'main') await atelier.git(['merge', '--ff-only', '-q', 'origin/main']);
    this.messageGit = ok ? '' : (atelier.modeDossier() ? 'Le dossier de la file de tâches est introuvable (réglages).' : "Impossible de joindre le dépôt git, nouvel essai plus tard (la file affichée peut être en retard).");
    try {
      const { taches, pauseCloud } = await atelier.lireFile(config);
      this.taches = taches;
      this.pauseCloud = pauseCloud;
      this.derniereReleve = Date.now();
    } catch (e) {
      this.messageGit = `Lecture de la file impossible : ${e.message}`;
      journal(this.messageGit);
    }
    this.releveDemandee = false;
  }

  prochaine() { return this.ordre()[0] || null; }

  // Une tâche mise de côté après plusieurs échecs (ex. Blender qui plante faute de mémoire graphique)
  // est retentée toute seule plus tard : ces plantages sont souvent passagers, et le rendu reprend à l'image près.
  // Après 3 séries d'échecs, elle attend le bouton « Réessayer ».
  bloquee(dossier, config) {
    const er = this.erreurs[dossier];
    if (!er || !er.bloquee) return false;
    const parSerie = Number(config.essaisParPlan) || 3;
    if (er.essais >= parSerie * 3) return true;
    return Date.now() - (er.quand || 0) < (Number(config.reessaiAutoMinutes) || 30) * 60000;
  }

  // tâches prêtes, dans l'ordre où elles seront faites
  ordre() {
    const config = lireConfig();
    const prets = this.taches.filter((t) => t.statut === 'pret' && !this.ignores.includes(t.dossier)
      && !this.bloquee(t.dossier, config));
    const rang = (t) => {
      const p = this.priorites.indexOf(t.dossier);
      return p >= 0 ? p : 1000;
    };
    prets.sort((a, b) => rang(a) - rang(b)
      || (config.voixAvantRendus ? (a.type === 'voix' ? 0 : 1) - (b.type === 'voix' ? 0 : 1) : 0)
      || a.date - b.date);
    return prets;
  }

  // ---------- boucle principale ----------
  async demarrer() {
    const src = source();
    journal(src ? `Rouages Studio démarré. File de tâches : ${src.chemin} (${src.type})` : 'Rouages Studio démarré. Aucune file de tâches : le guide de démarrage va s\'afficher.');
    for (;;) {
      try {
        await this.tour();
      } catch (e) {
        journal(`Problème inattendu : ${e.stack || e.message}`);
        this.veille(false);
        await this.attendre(60000);
      }
    }
  }

  async tour() {
    const config = lireConfig();
    const intervalle = Math.max(1, Number(config.releveMinutes) || 5) * 60000;
    if (this.releveDemandee || Date.now() - this.derniereReleve > intervalle || (this.etat === 'configuration' && source(config))) await this.relever();
    if (!source(config)) { this.etat = 'configuration'; this.veille(false); await this.attendre(intervalle); return; }

    if (!this.enMarche) { this.etat = 'pause'; this.veille(false); await this.attendre(intervalle); return; }

    if (this.pauseCloud) {
      this.etat = 'pause-cloud';
      this.veille(false);
      if (!this.pauseCloudSignalee) await this.signalerPauseCloud();
      await this.attendre(intervalle);
      return;
    }
    if (this.pauseCloudSignalee) { this.pauseCloudSignalee = false; this.sauver(); journal("La pause demandée depuis le cloud est levée : reprise de la file."); }

    const t = this.prochaine();
    if (!t) { this.etat = 'attente'; this.veille(false); await this.attendre(intervalle); return; }

    const autre = await this.autreProgramme();
    if (autre) {
      if (!this.occupePar) journal(`${autre.quoi} tourne déjà sur le PC (autre session) : le menu attend qu'il ait fini.`);
      this.occupePar = autre;
      this.etat = 'occupe';
      await this.attendre(60000);
      return;
    }
    this.occupePar = null;
    await this.executer(t);
  }

  async executer(t) {
    const config = lireConfig();
    const travail = path.join(dossierTravail(config), t.dossier);
    const fMeta = path.join(travail, 'meta.json');
    let meta = lireJson(fMeta, null);
    if (!meta || meta.arbre !== t.arbre || !fs.existsSync(path.join(travail, 'src'))) {
      if (meta && meta.arbre !== t.arbre) journal(`${t.dossier} : nouvelle version envoyée par le cloud, on repart de cette version (anciennes images effacées).`);
      try {
        fs.rmSync(travail, { recursive: true, force: true });
        await atelier.extraire(t, path.join(travail, 'src'));
      } catch (e) {
        journal(`${t.dossier} : impossible de préparer les fichiers (${e.message}).`);
        await this.attendre(60000);
        return;
      }
      meta = { arbre: t.arbre, plans: {} };
      ecrireJson(fMeta, meta);
    }
    const ctx = {
      tache: t, travail, config, meta, suivi: this.suivi = {}, controle: this.controle = { arreter: false, enfant: null },
      sauverMeta: () => ecrireJson(fMeta, meta),
    };
    this.enCours = t;
    this.etat = 'travail';
    this.veille(true);

    let plan = 0;
    let r;
    try {
      if (t.type === '3d') {
        for (let k = 1; k <= t.plans; k++) if (!t.plansFaits.includes(k)) { plan = k; break; }
        r = await rendrePlan(ctx, plan);
      } else {
        r = await genererVoix(ctx);
      }
    } catch (e) {
      r = { erreur: e.message };
    }
    this.enCours = null;

    if (r.pause) { journal(`${t.dossier} : arrêté proprement${plan ? ` au plan ${plan} (${this.suivi.images || 0} images gardées)` : ''}.`); return; }
    if (r.erreur) {
      const er = this.erreurs[t.dossier] = this.erreurs[t.dossier] || { essais: 0 };
      // le passage d'OptiX à CUDA après un plantage du GPU ne compte pas comme un essai raté
      if (!r.bascule) er.essais++;
      er.message = r.erreur; er.quand = Date.now();
      er.bloquee = er.essais >= (Number(config.essaisParPlan) || 3);
      const definitif = er.essais >= (Number(config.essaisParPlan) || 3) * 3;
      journal(`${t.dossier}${plan ? ` plan ${plan}` : ''} : ${r.erreur}${er.bloquee ? (definitif ? ' — mis de côté, bouton « Réessayer » dans le menu.' : ` — mis de côté, nouvel essai automatique dans ${Number(config.reessaiAutoMinutes) || 30} min (ou bouton « Réessayer »).`) : r.bascule ? '.' : ` — nouvel essai (${er.essais}/${config.essaisParPlan}).`}`);
      this.sauver();
      this.etat = 'reessai';
      this.veille(false);
      // après un plantage du GPU, on le laisse refroidir avant de retenter
      const delai = er.bloquee ? 1000 : r.gpu ? (Number(config.pauseApresPlantageGpu) || 120) * 1000 : 20000;
      this.reessai = { nom: nomEpisode(t), ep: t.ep, plan, gpu: !!r.gpu, cuda: !!r.gpu, misDeCote: er.bloquee, jusqua: Date.now() + delai, message: r.erreur };
      await this.attendre(delai);
      this.reessai = null;
      return;
    }
    delete this.erreurs[t.dossier];
    const quoi = t.type === '3d' ? `${t.ep} plan ${plan}/${t.plans}` : `${t.ep} voix`;
    this.historique.push({ quand: Date.now(), quoi, nom: nomEpisode(t), type: t.type, plan, plans: t.plans, dossier: t.dossier, secondes: r.secondes, images: r.images || 0, medias: r.medias || [] });
    journal(`Terminé : ${quoi}.`);
    if (t.type === '3d') {
      t.plansFaits.push(plan);
      // les images PNG du plan livré prennent de la place (≈ 3 Go par épisode) : le MP4 est livré, on les supprime
      fs.rmSync(path.join(travail, 'rendu', `p${plan}`), { recursive: true, force: true });
      if (t.plansFaits.length >= t.plans) { t.statut = 'fait'; fs.rmSync(travail, { recursive: true, force: true }); }
    } else {
      t.statut = 'fait';
      fs.rmSync(travail, { recursive: true, force: true });
    }
    this.priorites = this.priorites.filter((d) => d !== t.dossier || t.statut !== 'fait');
    if (this.pauseFinPlan) {
      this.pauseFinPlan = false;
      this.enMarche = false;
      journal('Pause demandée à la fin du plan : le PC est libre.');
    }
    this.sauver();
  }

  async signalerPauseCloud() {
    const derniers = this.historique.slice(-1)[0];
    const suivante = this.prochaine();
    const texte = `# État pause du PC (menu de rendu)\n\n` +
      `Pause vue le ${new Date().toISOString()} (fichier cloud-vers-pc/PAUSE).\n\n` +
      `- Dernier travail terminé : ${derniers ? derniers.quoi : 'aucun'}\n` +
      `- Prochain dans la file : ${suivante ? (suivante.type === '3d' ? `${suivante.ep} plan ${(suivante.plansFaits.length || 0) + 1}/${suivante.plans}` : `${suivante.ep} voix`) : 'rien'}\n` +
      `\nLa file reprend toute seule quand cloud-vers-pc/PAUSE disparaît.\n`;
    try {
      await atelier.livrer('', [], [{ nom: 'ETAT-PAUSE.md', texte, remplacer: true }], 'PC : en pause (cloud-vers-pc/PAUSE)');
      this.pauseCloudSignalee = true;
      this.sauver();
    } catch (e) { journal(`ETAT-PAUSE.md non envoyé : ${e.message}`); }
  }

  // ---------- commandes du menu ----------
  async action(nom, arg) {
    switch (nom) {
      case 'reprendre':
        this.enMarche = true; this.pauseFinPlan = false; journal('Reprise demandée.'); break;
      case 'pause-maintenant':
        this.enMarche = false; this.pauseFinPlan = false;
        if (this.controle.enfant) {
          this.controle.arreter = true;
          journal('Pause immédiate : arrêt du rendu en cours (les images déjà faites sont gardées).');
          await tuerArbre(this.controle.enfant.pid);
        } else journal('Pause.');
        this.veille(false);
        break;
      case 'pause-fin-plan':
        if (this.enCours) { this.pauseFinPlan = true; journal('Pause prévue à la fin du plan en cours.'); } else { this.enMarche = false; journal('Pause.'); }
        break;
      case 'annuler-pause-fin-plan':
        this.pauseFinPlan = false; break;
      case 'rafraichir':
        this.releveDemandee = true; break;
      case 'ignorer':
        if (arg && !this.ignores.includes(arg)) this.ignores.push(arg); break;
      case 'retablir':
        this.ignores = this.ignores.filter((d) => d !== arg); break;
      case 'prioriser':
        this.priorites = [arg, ...this.priorites.filter((d) => d !== arg)]; break;
      case 'reessayer':
        delete this.erreurs[arg]; break;
      case 'liberer-gpu':
        if (this.occupePar) { for (const pid of this.occupePar.pids) await tuerArbre(pid); journal(`${this.occupePar.quoi} de l'autre session arrêté à la demande.`); this.occupePar = null; }
        break;
      case 'ouvrir-dossier': {
        const src = source();
        const cible = arg === 'journal' || !src ? DONNEES : path.join(src.chemin, 'pc-vers-cloud');
        fs.mkdirSync(cible, { recursive: true });
        if (WINDOWS) executer('explorer', [cible]);
        break;
      }
      default:
        throw new Error(`commande inconnue : ${nom}`);
    }
    this.sauver();
    this.reveiller();
  }

  async arreterTout() {
    this.controle.arreter = true;
    if (this.controle.enfant) await tuerArbre(this.controle.enfant.pid);
    this.veille(false);
  }

  imageApercu() { return (this.enCours && this.suivi && this.suivi.derniereImage) || null; }

  fileAffichee() {
    const ordre = this.ordre();
    const reste = this.taches.filter((t) => t.statut !== 'fait' && !ordre.includes(t));
    const poids = (t) => (this.ignores.includes(t.dossier) ? 3 : t.statut === 'attente' ? 2 : 1);
    reste.sort((a, b) => poids(a) - poids(b) || a.date - b.date);
    return [...ordre, ...reste];
  }

  // ---------- état pour l'écran ----------
  public() {
    const config = lireConfig();
    const s = this.suivi || {};
    let enCours = null;
    if (this.enCours) {
      const t = this.enCours;
      const restantes = s.total ? Math.max(0, s.total - (s.images || 0)) : 0;
      let eta = s.secondesParImage && restantes ? Math.round(restantes * s.secondesParImage) : null;
      let fraction = s.total ? (s.images || 0) / s.total : null;
      if (t.type === 'voix' && s.estimationSecondes) {
        const ecoule = (Date.now() - s.debutPlan) / 1000;
        fraction = Math.min(0.97, ecoule / s.estimationSecondes);
        eta = Math.max(0, Math.round(s.estimationSecondes - ecoule));
      }
      enCours = {
        dossier: t.dossier, ep: t.ep, titre: t.titre, nom: nomEpisode(t), type: t.type, plan: s.plan, plans: t.plans,
        plansFaits: (t.plansFaits || []).length, images: s.images || 0, total: s.total || 0, fraction,
        secondesParImage: s.secondesParImage ? Math.round(s.secondesParImage * 10) / 10 : null, eta,
        etape: s.etape, derniereLigne: s.derniereLigne, depuis: s.debutPlan, apercu: !!s.derniereImage,
      };
    }
    return {
      etat: this.etat, enMarche: this.enMarche, pauseFinPlan: this.pauseFinPlan, pauseCloud: this.pauseCloud,
      enCours, reessai: this.etat === 'reessai' ? this.reessai : null, occupePar: this.occupePar ? this.occupePar.quoi : null, messageGit: this.messageGit,
      derniereReleve: this.derniereReleve, prochaineReleve: this.derniereReleve + Math.max(1, Number(config.releveMinutes) || 5) * 60000,
      file: this.fileAffichee().map((t) => ({
        dossier: t.dossier, ep: t.ep, titre: t.titre, nom: nomEpisode(t), type: t.type, statut: t.statut, plans: t.plans || 0,
        plansFaits: (t.plansFaits || []).length, ignore: this.ignores.includes(t.dossier),
        priorite: this.priorites.indexOf(t.dossier), erreur: this.erreurs[t.dossier] || null, message: t.message || '',
        rang: this.ordre().indexOf(t) + 1, date: t.date,
      })),
      prochaine: (this.prochaine() || {}).dossier || null,
      historique: this.historique.slice(-15).reverse(),
      faitAujourdhui: this.historique.filter((h) => new Date(h.quand).toDateString() === new Date().toDateString()).length,
      chemins: {
        source: source(config), travail: dossierTravail(config), donnees: DONNEES, blender: trouverBlender(config), ffmpeg: trouverFfmpeg(config),
        python: trouverPython(config), dossierVoix: dossierVoix(config),
      },
    };
  }
}

module.exports = { Moteur };
