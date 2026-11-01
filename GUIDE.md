# Rouages Studio — notice

Rouages Studio fabrique tes vidéos **sur ton PC, tout seul** : voix, rendus 3D Blender, vidéos MP4.
Tu peux mettre en pause à tout moment pour libérer le PC, et reprendre **à l'image exacte** où ça s'était arrêté.
Aucune clé ni abonnement n'est nécessaire pour les rendus.

## Installer (3 minutes)

1. Télécharge l'app : sur sa page GitHub, bouton **Code › Download ZIP**, puis décompresse-la où tu veux (par exemple dans `Documents`).
2. Double-clique sur **`Rouages-Studio.bat`**.
   - Si Node.js manque, il propose de l'installer (réponds `O`).
   - Un raccourci **« Rouages Studio »** apparaît sur le Bureau : la prochaine fois, utilise-le.
3. L'application s'ouvre dans sa propre fenêtre et lance le **guide de démarrage** :
   - **Logiciels** : coche verte = installé. Le bouton « Installer » s'occupe de ce qui manque (Blender, ffmpeg…).
   - **Dossier de travail** : où ranger les images en cours de rendu (prévois 20 Go libres).
   - **File de tâches** : où trouver les vidéos à fabriquer (voir plus bas).
   - **Clé Claude** : facultative, pour les futurs onglets Idées et Génération.

Le guide se rouvre à tout moment avec le bouton **?** en haut.

### Ou : laisser Claude tout installer

Dans le guide, choisis « Claude l'installe pour moi » : l'app te donne un texte à copier dans Claude Code.
Si l'app ne se lance pas du tout, copie ce texte tel quel dans Claude Code :

```
Installe et configure l'application « Rouages Studio » sur mon PC Windows.
Je l'ai téléchargée : cherche le dossier qui contient « Rouages-Studio.bat » (en général dans Téléchargements ou sur le Bureau, parfois encore dans un fichier .zip à décompresser).

1. Lis le fichier GUIDE.md de ce dossier : il explique tout.
2. Vérifie ce qui est installé et installe ce qui manque avec winget, en me montrant chaque commande :
   Node.js LTS (OpenJS.NodeJS.LTS), Blender (BlenderFoundation.Blender), ffmpeg (Gyan.FFmpeg),
   Git (Git.Git) si la file est un dépôt GitHub, Python 3 si je veux générer des voix.
3. Lance « Rouages-Studio.bat » : il crée le raccourci sur le Bureau et ouvre l'app (http://localhost:4747).
4. Aide-moi à finir le guide de démarrage de l'app.

Règles : ne mets jamais ma clé API, mes mots de passe ni mes infos personnelles dans un dépôt git,
un fichier partagé ou un message public. Demande-moi avant toute action que tu ne peux pas annuler.
```

## L'écran

**Rendus**
- **L'anneau** : l'avancement du plan en cours. Le fin trait orange autour : la vidéo entière.
- **Les chiffres** : temps par image, temps restant, heure de fin, temps écoulé. La vignette « LIVE » montre la dernière image rendue.
- **Le gros bouton** : **Mettre en pause** (le PC est libre en 2 secondes) ou **Reprendre**.
  Le lien « finir ce plan d'abord » termine le plan en cours, puis met en pause.
- **Ensuite** : les prochaines vidéos. Survole une ligne : flèche = la faire en premier, croix = la mettre de côté.
- **Envoyé** : clique sur une ligne pour regarder la vidéo ou écouter la voix.

**Médias** : toutes les vidéos et voix terminées. ▶ joue tous les plans d'une vidéo à la suite.
Dans le lecteur, « Ouvrir » lance le fichier avec le lecteur de Windows.

**Voix** : ta voix de référence et les dernières voix générées.

**Idées** (clé Claude) : choisis tes catégories, « Proposer des idées », coche celles qui te plaisent.

**Génération** (clé Claude) : choisis la voix et qui décide (« Je relis le texte » ou « L'IA fait tout »), puis « Lancer la création ».
Claude écrit le texte et le découpage ; en mode relecture, tu corriges avec une remarque ou tu valides.
Ensuite Claude construit la scène Blender et dépose la voix et la scène dans la file : ton PC les fabrique comme le reste.
Avec « L'app apprend de mes remarques », tes remarques servent aux vidéos suivantes.
La dépense Claude du mois s'affiche en haut de la liste (chaque idée ou texte coûte quelques centimes).

**Publication** (point orange) : les légendes prêtes à copier, et ton compte de publication (gardé sur ce PC).
La publication en un clic et les stats arrivent ensuite.

La ligne éditoriale, les catégories, la durée visée et la commande de voix se règlent dans `donnees\config.json`
(`ligneEditoriale`, `categories`, `dureeCible`, `commandeVoix`).

**Roue dentée** : réglages, journal, dossiers, notice, et « Fermer Rouages Studio ».

Les onglets défilent avec la molette, les flèches sur les bords, ou les flèches ← → du clavier.

Fermer la fenêtre **n'arrête pas** le travail : il continue en arrière-plan. Pour tout arrêter : roue dentée › Fermer.
L'app se souvient de son état : si elle était en pause quand tu as éteint le PC, elle reste en pause.

## La file de tâches

C'est un dossier (ou un dépôt GitHub) organisé ainsi :

```
cloud-vers-pc/
  ep12-3d/        une scène 3D à rendre
    A-FAIRE.md    la demande
    ep12_scenes.py
  ep12-voix/      une voix à générer
    A-FAIRE.md
    ep12.txt
pc-vers-cloud/    les résultats arrivent ici (ep12-final/ep12-plan1.mp4, …)
```

- **Dépôt GitHub** : l'app regarde la branche `main` et les branches `claude/…`, et renvoie les vidéos sur `main`.
  Pratique pour qu'un Claude dans le cloud prépare les scènes pendant que ton PC rend.
- **Dossier simple** : tu déposes les dossiers à la main, les vidéos apparaissent dans `pc-vers-cloud`.

### Une demande de rendu 3D (`epNN-3d` ou `epNN-final`)

`A-FAIRE.md` doit contenir :
- la commande Blender avec le script : `blender -b -P ep12_scenes.py` ;
- le nombre de plans, par exemple « plans 1 à 6 » (sinon il est lu dans `NV = {1: …, 2: …}` du script) ;
- facultatif : le dossier de sortie `pc-vers-cloud/ep12-final/`.

Le script Blender doit lire `--plan N` et `--sortie <préfixe>` après `--`, et appeler `bpy.ops.render.render(animation=True)`.
Écrire « PAS ENCORE PRÊT » dans `A-FAIRE.md` met la demande en attente.

### Une demande de voix (`epNN-voix`)

`A-FAIRE.md` contient la commande, par exemple `python voix.py ep12.txt 3 ep12 --ref reference.wav`.
L'app copie le texte dans le **dossier des voix** (celui qui contient ton `voix.py`, à régler dans la roue dentée)
et y lance la commande, puis range les fichiers produits.

### Noms des vidéos

Pour afficher de jolis noms, mets un fichier `noms.json` à la racine de la file : `{ "ep12": "Le titre" }`.

### Pause demandée à distance

Un fichier `cloud-vers-pc/PAUSE` met l'app en pause après le plan en cours ; elle repart quand il disparaît.

## Sans internet

Le rendu, la voix, la fabrication des MP4, la pause et la reprise marchent **sans connexion**.
Avec une file sur GitHub, seules la récupération des nouvelles tâches et l'envoi des vidéos attendent le retour d'internet
(les vidéos sont gardées et repartent toutes seules). Les onglets Idées et Génération ont besoin d'internet (ils parlent à Claude).

## Sans dommage, même si…

- **Tu cliques « Mettre en pause »** : seule l'image en cours de calcul est à refaire.
- **Le PC s'éteint ou plante** : au redémarrage, les images coupées sont détectées et refaites, le reste est gardé.
- **Blender plante** (mémoire de la carte graphique) : l'app relance le plan (3 essais), puis propose « Réessayer ».
- **Internet coupe** : la vidéo est gardée et renvoyée dès que ça revient.
- **Un autre Blender tourne déjà** : l'app attend qu'il ait fini (ou bouton « Prendre la main »).

Pendant un rendu, l'app empêche Windows de se mettre en veille. Sur un portable : branché, et capot ouvert.
Ferme les jeux avant de reprendre : ils partagent la carte graphique.

## Où sont les fichiers

- **Réglages, journal, état** : le dossier `donnees` à côté de l'app. Rien de personnel n'est envoyé nulle part.
- **La clé Claude** (si tu en mets une) : uniquement dans `donnees\config.json`, sur ce PC.
  Ne partage jamais ce dossier `donnees`.
- **Images en cours** : le dossier de travail choisi dans le guide (effacées dès que la vidéo est prête).
- **Vidéos finies** : `pc-vers-cloud` dans la file de tâches.

## Partager l'application

Donne le lien de la page GitHub de l'app, ou envoie le dossier **sans** le dossier `donnees` (ni `node_modules`). Ton ami double-clique sur `Rouages-Studio.bat`, le guide fait le reste.
