/**
 * CreatureFiles — where a creature's two modules come from.
 *
 * The creature files stay in tools/creature/ — one home, edited there by the
 * sessions that build the animals and checked there by seam-check.mjs. Vite
 * lists them: it rewrites the two glob calls below into file maps when it
 * serves or builds this, and makes each file its own lazily loaded chunk, so
 * an animal costs nothing until it is chosen.
 *
 * Its own file because import.meta.glob exists only under Vite: everything
 * else about creatures (CreatureObject.js, CreatureParams.js) loads in plain
 * Node, where the audits run it.
 */

const DEF_FILES  = import.meta.glob('../../tools/creature/*-def.js');
const VIEW_FILES = import.meta.glob('../../tools/creature/*-view.js');
const DIR = '../../tools/creature/';

/** An animal's definition, and its view (own <key>-view.js, or a block in views.js). */
export async function loadCreatureFiles(key) {
  const defLoad = DEF_FILES[`${DIR}${key}-def.js`];
  if (!defLoad) throw new Error(`no ${key}-def.js in tools/creature/`);
  const viewLoad = VIEW_FILES[`${DIR}${key}-view.js`];
  const [def, view] = await Promise.all([
    defLoad(),
    viewLoad ? viewLoad().then(m => m.VIEW) : import('../../tools/creature/views.js').then(m => m.VIEWS[key]),
  ]);
  if (!view) throw new Error(`no view for "${key}" (${key}-view.js, or a block in views.js)`);
  return { def, view };
}
