// Création avec Claude : idées par catégorie, texte + découpage, scène Blender, dépôt dans la file de tâches.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DONNEES, lireConfig, lireJson, ecrireJson, journal, source } = require('./commun');
const { demanderJson } = require('./claude');
const atelier = require('./atelier-git');

const F_IDEES = path.join(DONNEES, 'idees.json');
const F_PROJETS = path.join(DONNEES, 'projets.json');
const F_AVIS = path.join(DONNEES, 'avis.json');
const id = () => crypto.randomBytes(5).toString('hex');

// ---------- schémas des réponses ----------
const S_IDEES = {
  type: 'object', additionalProperties: false, required: ['idees'],
  properties: { idees: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['categorie', 'titre', 'accroche', 'pourquoi'],
    properties: { categorie: { type: 'string' }, titre: { type: 'string' }, accroche: { type: 'string' }, pourquoi: { type: 'string' } },
  } } },
};
const S_SCRIPT = {
  type: 'object', additionalProperties: false,
  required: ['titre', 'accroche', 'texte_voix', 'plans', 'legende', 'hashtags'],
  properties: {
    titre: { type: 'string' },
    accroche: { type: 'string' },
    texte_voix: { type: 'string' },
    plans: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['numero', 'secondes', 'texte', 'image'],
      properties: { numero: { type: 'integer' }, secondes: { type: 'number' }, texte: { type: 'string' }, image: { type: 'string' } },
    } },
    legende: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
};
const S_SCENE = {
  type: 'object', additionalProperties: false, required: ['script_python', 'notes'],
  properties: { script_python: { type: 'string' }, notes: { type: 'string' } },
};

// ---------- mémoire des avis ----------
function avisRecents(n = 15) {
  if (!lireConfig().apprendre) return '';
  const a = lireJson(F_AVIS, []).slice(-n);
  return a.length ? `\n\nRetours précédents de l'utilisateur sur ses vidéos (à respecter) :\n${a.map((x) => `- ${x.texte}`).join('\n')}` : '';
}
function noterAvis(texte, projet) {
  if (!texte || !lireConfig().apprendre) return;
  const a = lireJson(F_AVIS, []);
  a.push({ quand: Date.now(), texte: String(texte).slice(0, 600), projet });
  ecrireJson(F_AVIS, a.slice(-200));
}

function systeme(config) {
  return `Tu aides une chaîne de vidéos courtes verticales (Shorts, TikTok, Reels), en ${config.langue}.
Ligne éditoriale : ${config.ligneEditoriale}
Tout ce que tu écris doit être exact : pas de fait inventé, pas d'exagération trompeuse.${avisRecents()}`;
}

// ---------- idées ----------
function lireIdees() { return lireJson(F_IDEES, { propositions: [], selection: [], dejaVues: [] }); }

async function proposerIdees(categories, parCategorie = 4) {
  const config = lireConfig();
  const cats = (categories && categories.length ? categories : config.categories).slice(0, 8);
  const etat = lireIdees();
  const deja = [...etat.dejaVues.slice(-80), ...projets().map((p) => p.titre)];
  const { donnees, dollars } = await demanderJson({
    quoi: 'idées',
    system: systeme(config),
    prompt: `Propose ${parCategorie} idées de vidéos pour chacune de ces catégories : ${cats.join(' ; ')}.
Chaque idée : un titre court, la phrase d'accroche de la première seconde (affirmative, surprenante, vraie), et en une phrase pourquoi les gens la regarderont jusqu'au bout et la partageront.
Idées à éviter car déjà vues : ${deja.length ? deja.join(' | ') : 'aucune'}.`,
    schema: S_IDEES,
    effort: 'medium',
  });
  const nouvelles = donnees.idees.map((x) => Object.assign({ id: id(), date: Date.now() }, x));
  // on remplace les anciennes propositions des catégories demandées, on garde la sélection
  const gardees = etat.propositions.filter((p) => !cats.includes(p.categorie) || etat.selection.includes(p.id));
  etat.propositions = [...gardees, ...nouvelles];
  etat.dejaVues = [...etat.dejaVues, ...nouvelles.map((x) => x.titre)].slice(-300);
  ecrireJson(F_IDEES, etat);
  return { nouvelles: nouvelles.length, dollars };
}

function selectionner(ids) {
  const etat = lireIdees();
  etat.selection = (ids || []).filter((x) => etat.propositions.some((p) => p.id === x));
  ecrireJson(F_IDEES, etat);
}

// ---------- projets (une vidéo en création) ----------
function projets() { return lireJson(F_PROJETS, []); }
function sauverProjet(p) {
  const l = projets();
  const k = l.findIndex((x) => x.id === p.id);
  if (k >= 0) l[k] = p; else l.push(p);
  ecrireJson(F_PROJETS, l.slice(-200));
}
let surDepot = () => {};
const quandDepose = (f) => { surDepot = f; };
const enCours = new Set();     // projets qui travaillent en ce moment (un appel à Claude à la fois par projet)

function prochainEp(tachesConnues) {
  let max = 0;
  const voir = (nom) => { const m = String(nom).match(/^ep(\d+)/i); if (m) max = Math.max(max, Number(m[1])); };
  (tachesConnues || []).forEach((t) => voir(t.dossier));
  projets().forEach((p) => voir(p.ep));
  const src = source();
  if (src) for (const base of ['cloud-vers-pc', 'pc-vers-cloud']) { try { fs.readdirSync(path.join(src.chemin, base)).forEach(voir); } catch (e) { /* vide */ } }
  return `ep${String(max + 1).padStart(2, '0')}`;
}

// Crée les projets à partir des idées choisies et lance l'écriture des textes.
function creer(idsIdees, options, tachesConnues) {
  const etat = lireIdees();
  const choisies = etat.propositions.filter((p) => idsIdees.includes(p.id));
  const crees = [];
  for (const idee of choisies) {
    const p = {
      id: id(), ep: prochainEp(tachesConnues), titre: idee.titre, idee,
      voix: options.voix || lireConfig().voixParDefaut || '', style: options.style || '3d',
      mode: options.mode || lireConfig().modeCreation, etat: 'texte', message: 'Écriture du texte…',
      remarques: [], cout: 0, cree: Date.now(),
    };
    sauverProjet(p);
    crees.push(p);
    avancer(p.id);
  }
  etat.selection = etat.selection.filter((x) => !idsIdees.includes(x));
  etat.propositions = etat.propositions.filter((x) => !idsIdees.includes(x.id));
  ecrireJson(F_IDEES, etat);
  return crees;
}

async function ecrireTexte(p) {
  const config = lireConfig();
  const corrections = p.remarques.length ? `\n\nVersion précédente :\n${JSON.stringify(p.script)}\n\nCorrections demandées par l'utilisateur :\n${p.remarques.map((r) => '- ' + r).join('\n')}` : '';
  const { donnees, dollars } = await demanderJson({
    quoi: `texte ${p.ep}`,
    system: systeme(config),
    prompt: `Écris la vidéo « ${p.idee.titre} » (accroche proposée : « ${p.idee.accroche} »).
Durée visée : ${config.dureeCible} secondes de voix (environ ${Math.round(config.dureeCible * 2.6)} mots).
- texte_voix : le texte lu par la voix off, d'un seul bloc, phrases courtes, aucun mot répété inutilement, la première phrase est l'accroche.
- plans : 4 à 7 plans visuels dans l'ordre ; pour chacun le texte dit pendant le plan, sa durée en secondes, et une description précise de l'image 3D à montrer (objets, matières, lumière, mouvement de caméra).
- legende : la légende de publication (2 phrases max) qui donne envie de partager ; hashtags : 3 à 5.${corrections}`,
    schema: S_SCRIPT,
    effort: 'high',
  });
  p.script = donnees;
  p.titre = donnees.titre || p.titre;
  p.cout += dollars;
}

async function ecrireScene(p) {
  const s = p.script;
  const total = s.plans.reduce((x, y) => x + (Number(y.secondes) || 0), 0);
  const { donnees, dollars } = await demanderJson({
    quoi: `scène 3D ${p.ep}`,
    system: `Tu écris des scripts Python pour Blender (bpy, Blender 4 ou plus récent) qui construisent une scène 3D propre et la rendent, sans aucun fichier externe.`,
    prompt: `Écris UN script Blender autonome pour la vidéo « ${s.titre} » (${s.plans.length} plans, ${Math.round(total)} s au total).
Plans :
${s.plans.map((x) => `${x.numero}. ${x.secondes} s : ${x.image}`).join('\n')}

Contrat obligatoire :
- Lire les arguments après « -- » dans sys.argv : --plan N (numéro du plan à rendre) et --sortie PREFIXE (chemin + début du nom des images).
- Construire la scène du plan N avec des primitives et des matériaux procéduraux (aucune texture ni modèle externe), fond sombre, éclairage soigné (3 points ou HDRI procédural), reflets, pas de formes molles.
- Vidéo verticale 1080x1920, 30 images/s, moteur EEVEE (BLENDER_EEVEE_NEXT si disponible, sinon BLENDER_EEVEE), échantillons 32, sortie PNG.
- Plan N : frame_start = 1, frame_end = round(durée du plan × 30). Animation fluide (keyframes avec interpolation douce), caméra qui bouge doucement.
- render.filepath = PREFIXE, render.use_overwrite = False (pour reprendre après une pause), puis bpy.ops.render.render(animation=True).
- Définir en haut du script un dictionnaire NV = {1: ..., 2: ...} qui donne le nombre d'images de chaque plan.
- Pas de texte à l'écran (les sous-titres sont ajoutés au montage).
notes : en une ou deux phrases, ce que montre la scène.`,
    schema: S_SCENE,
    effort: 'high',
    maxTokens: 64000,
  });
  p.scene = donnees.script_python;
  p.notesScene = donnees.notes;
  p.cout += dollars;
}

function commandeVoix(config, p) {
  return (config.commandeVoix || 'python voix.py {texte} 3 {ep} --ref {voix}')
    .replace('{texte}', `${p.ep}.txt`).replace('{ep}', p.ep).replace('{voix}', p.voix || 'reference.wav');
}

async function deposerDansFile(p) {
  const config = lireConfig();
  const s = p.script;
  await atelier.deposer(`${p.ep}-voix`, [
    { nom: `${p.ep}.txt`, texte: s.texte_voix + '\n' },
    { nom: 'A-FAIRE.md', texte: `# ${p.ep} voix : « ${s.titre} »\n\nCréé par Rouages Studio.\n\n\`\`\`\n${commandeVoix(config, p)}\n\`\`\`\n\nSortie : pc-vers-cloud/${p.ep}-voix/\n` },
  ], `${p.ep} : voix à générer (Rouages Studio)`);
  if (p.style === '3d' && p.scene) {
    const n = s.plans.length;
    await atelier.deposer(`${p.ep}-3d`, [
      { nom: `${p.ep}_scenes.py`, texte: p.scene },
      { nom: 'A-FAIRE.md', texte: `# ${p.ep} 3D : « ${s.titre} »\n\nCréé par Rouages Studio. ${p.notesScene || ''}\n\n\`\`\`\nblender -b -P ${p.ep}_scenes.py -- --plan N --sortie <prefixe>\n\`\`\`\n\nPlans 1 à ${n}.\nSortie : pc-vers-cloud/${p.ep}-final/\n\n## Plans\n${s.plans.map((x) => `${x.numero}. (${x.secondes} s) ${x.image}`).join('\n')}\n` },
    ], `${p.ep} : scène 3D à rendre (Rouages Studio)`);
  }
  // le nom de la vidéo pour l'affichage
  const src = source();
  if (src) {
    const f = path.join(src.chemin, 'noms.json');
    const noms = lireJson(f, {});
    if (!noms[p.ep]) { noms[p.ep] = s.titre; await atelier.envoyer('', '', [], [{ nom: 'noms.json', texte: JSON.stringify(noms, null, 2) + '\n', remplacer: true }], `${p.ep} : nom « ${s.titre} »`).catch(() => {}); }
  }
}

// Fait avancer un projet jusqu'à la prochaine étape où il attend quelqu'un.
async function avancer(idProjet) {
  if (enCours.has(idProjet)) return;
  enCours.add(idProjet);
  let p = projets().find((x) => x.id === idProjet);
  try {
    while (p) {
      if (p.etat === 'texte') {
        p.message = 'Claude écrit le texte et le découpage…'; sauverProjet(p);
        await ecrireTexte(p);
        p.etat = p.mode === 'auto' ? 'scene' : 'a-valider';
        p.message = p.mode === 'auto' ? '' : 'Texte prêt : relis-le, corrige ou valide.';
        sauverProjet(p);
      } else if (p.etat === 'scene') {
        if (p.style === '3d') { p.message = 'Claude construit la scène 3D…'; sauverProjet(p); await ecrireScene(p); }
        p.etat = 'depot'; sauverProjet(p);
      } else if (p.etat === 'depot') {
        p.message = 'Envoi dans la file de rendus…'; sauverProjet(p);
        await deposerDansFile(p);
        p.etat = 'envoye'; p.message = 'Dans la file : la voix puis le rendu vont se lancer.'; p.envoye = Date.now();
        sauverProjet(p);
        journal(`${p.ep} « ${p.titre} » créé et envoyé dans la file.`);
        try { surDepot(); } catch (e) { /* rien */ }
      } else break;
      p = projets().find((x) => x.id === idProjet);
    }
  } catch (e) {
    p = projets().find((x) => x.id === idProjet) || p;
    p.erreur = e.message; p.etatAvantErreur = p.etat; p.etat = 'erreur'; p.message = e.message;
    sauverProjet(p);
    journal(`${p.ep} : ${e.message}`);
  } finally { enCours.delete(idProjet); }
}

function actionProjet(idProjet, action, texte) {
  const p = projets().find((x) => x.id === idProjet);
  if (!p) throw new Error('projet introuvable');
  if (action === 'corriger') {
    if (!texte) throw new Error('écris ce qu’il faut changer');
    p.remarques.push(texte); noterAvis(texte, p.ep); p.etat = 'texte';
  } else if (action === 'valider') {
    if (texte) noterAvis(texte, p.ep);
    p.etat = 'scene';
  } else if (action === 'reessayer') {
    p.etat = p.etatAvantErreur || 'texte'; delete p.erreur;
  } else if (action === 'supprimer') {
    ecrireJson(F_PROJETS, projets().filter((x) => x.id !== idProjet)); return;
  } else if (action === 'voix') { p.voix = texte; sauverProjet(p); return; }
  else throw new Error('action inconnue');
  p.message = ''; sauverProjet(p);
  avancer(p.id);
}

// au démarrage : reprendre les projets laissés en plein travail
function reprendre() {
  for (const p of projets()) if (['texte', 'scene', 'depot'].includes(p.etat)) avancer(p.id);
}

function etat() {
  const i = lireIdees();
  return { idees: i.propositions, selection: i.selection, projets: projets().slice().reverse().map((p) => Object.assign({}, p, { travaille: enCours.has(p.id), scene: undefined, aScene: !!p.scene })) };
}

module.exports = { proposerIdees, selectionner, creer, actionProjet, etat, reprendre, noterAvis, quandDepose };
