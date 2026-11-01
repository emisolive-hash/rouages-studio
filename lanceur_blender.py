# Lanceur Blender de Rouages Studio.
# blender -b -P lanceur_blender.py -- --plan N --sortie ...   (variable ROUAGES_SCENE = script de scène)
# Il exécute le script de scène tel quel, et juste avant le rendu il annonce la plage d'images
# et chaque image terminée, pour la barre de progression du menu.
import bpy, os, sys

SCENE = os.environ['ROUAGES_SCENE']
sys.path.insert(0, os.path.dirname(os.path.abspath(SCENE)))


def _image_finie(scene, *_):
    print('ROUAGES_IMAGE %d' % scene.frame_current, flush=True)


def forcer_peripherique(type_):
    # ROUAGES_PERIPHERIQUE=CUDA : après un plantage du GPU en OptiX, on retente en CUDA (plus stable)
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = type_
        prefs.get_devices()
        for d in prefs.devices:
            d.use = (d.type == type_)
        bpy.context.scene.cycles.device = 'GPU'
        print('ROUAGES_INFO rendu en %s' % type_, flush=True)
    except Exception as e:
        print('ROUAGES_INFO impossible de passer en %s : %s' % (type_, e), flush=True)


def avant_rendu():
    sc = bpy.context.scene
    if os.environ.get('ROUAGES_PERIPHERIQUE') and sc.render.engine == 'CYCLES':
        forcer_peripherique(os.environ['ROUAGES_PERIPHERIQUE'])
    print('ROUAGES_PLAGE %d %d' % (sc.frame_start, sc.frame_end), flush=True)
    print('ROUAGES_SORTIE %s' % sc.render.filepath, flush=True)
    bpy.app.handlers.render_post.append(_image_finie)


with open(SCENE, encoding='utf-8') as f:
    code = f.read()
APPEL = 'bpy.ops.render.render(animation=True)'
if APPEL in code:
    code = code.replace(APPEL, '__rouages_avant_rendu(); ' + APPEL)
else:
    print('ROUAGES_INFO pas de point d accroche, progression par comptage des images', flush=True)

espace = {'__name__': '__main__', '__file__': os.path.abspath(SCENE), '__rouages_avant_rendu': avant_rendu}
exec(compile(code, os.path.abspath(SCENE), 'exec'), espace)
print('ROUAGES_FINI', flush=True)
