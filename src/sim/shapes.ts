/**
 * The triangles of a model, for a collider that is exactly its shape: a shaped piece of an arena
 * (an arch, a dome, a curved stair made with the modelling kit) is walked on and bumped into as
 * drawn. The recipe builder (model/mesh.ts) makes the geometry, the same the page draws.
 */

import { apply, partTransform } from '../model/kit'
import { buildModel, disposeModel } from '../model/mesh'
import type { Recipe } from '../protocol'

/** Every triangle of the model at rest, in its own frame, scaled: x, y, z per corner, three corners a triangle. */
export function recipeTriangles(recipe: Recipe, scale: number): Float32Array {
  const model = buildModel(recipe)
  const out: number[] = []
  try {
    for (const [part, g] of model.parts) {
      const { p, r } = partTransform(recipe.parts, part)
      for (const geo of [g.solid, g.glow]) {
        if (!geo) continue
        const pos = geo.getAttribute('position')
        for (let i = 0; i < pos.count; i++) {
          const v = apply(r, [pos.getX(i), pos.getY(i), pos.getZ(i)])
          out.push((v[0] + p[0]) * scale, (v[1] + p[1]) * scale, (v[2] + p[2]) * scale)
        }
      }
    }
  } finally {
    disposeModel(model)
  }
  return new Float32Array(out)
}
