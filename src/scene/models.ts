/**
 * Models as three.js: a recipe (shapes from the modelling kit) becomes merged geometry per part
 * through the builder in model/mesh.ts, drawn here in this game's own materials. A model is
 * built once per recipe and shared; an instance is a tree of groups, one per part, so a pose
 * turns a part with everything on it.
 */

import { Color, Euler, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Material } from 'three'

import type { PartDef } from '../model/kit'
import { buildModel, type Model, type ModelUse } from '../model/mesh'
import type { Recipe, Vec3 } from '../protocol'
import { PAINT_DOCTOR, PAINT_MODEL, harmonizeColors, paint, type PaintOpts } from './paint'

const modelMaterial = (o: PaintOpts) => paint(new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 }), o)

let solid: MeshStandardMaterial | null = null
/** Models' shapes: their own colours on the page's fine paper, a little shine. */
export function solidMaterial(): MeshStandardMaterial {
  solid ??= modelMaterial(PAINT_MODEL)
  return solid
}

let worn: MeshStandardMaterial | null = null
/** What a doctor wears (hats, hair, capes), painted as the doctor under it is, not engraved as a thing in hand. */
function wornMaterial(): MeshStandardMaterial {
  worn ??= modelMaterial(PAINT_DOCTOR)
  return worn
}

/** Glowing shapes: brighter than white, so the bloom catches them (the lighting tab scales it). */
export const GLOW_BASE = 1.7
export const GLOW = new MeshBasicMaterial({ vertexColors: true, color: new Color(GLOW_BASE, GLOW_BASE, GLOW_BASE) })

/** How the page draws a model: as a thing or a piece of the arena, or worn by a doctor (finer and soft: mesh.ts). */
export type DrawnUse = Exclude<ModelUse, 'collider'>
const built: Record<DrawnUse, WeakMap<Recipe, Model>> = { drawn: new WeakMap(), worn: new WeakMap() }

/** A model's geometry as the page draws it (the insides of open shells too), built once per recipe and use, its colours brought into the painting's range. */
export function modelOf(recipe: Recipe, use: DrawnUse): Model {
  let m = built[use].get(recipe)
  if (!m) {
    m = buildModel(recipe, use)
    for (const g of m.parts.values()) {
      if (g.solid) harmonizeColors(g.solid.getAttribute('color'))
      if (g.glow) harmonizeColors(g.glow.getAttribute('color'), true)
    }
    built[use].set(recipe, m)
  }
  return m
}

/** One drawn copy of a model. */
export class ModelInstance {
  readonly root = new Group()
  /** Each part's group, as the recipe makes them (parents first). Copies of a part made under one name are each here, posed by that name. */
  readonly parts: { def: PartDef; group: Group }[] = []
  readonly meshes: Mesh[] = []

  constructor(
    readonly recipe: Recipe,
    solid: Material = solidMaterial(),
    glow: Material = GLOW,
    use: DrawnUse = 'drawn',
  ) {
    const model = modelOf(recipe, use)
    const groups = new Map<string | null, Group>([[null, this.root]])
    for (const def of recipe.parts) {
      const g = new Group()
      g.position.set(def.at[0], def.at[1], def.at[2])
      g.rotation.set(def.rot[0], def.rot[1], def.rot[2], 'XYZ')
      groups.get(def.parent)!.add(g)
      groups.set(def.name, g)
      this.parts.push({ def, group: g })
    }
    for (const [part, geo] of model.parts) {
      const parent = groups.get(part) ?? this.root
      for (const [geometry, material] of [
        [geo.solid, solid],
        [geo.glow, glow],
      ] as const) {
        if (!geometry) continue
        const mesh = new Mesh(geometry, material)
        mesh.castShadow = material === solid
        mesh.receiveShadow = false
        parent.add(mesh)
        this.meshes.push(mesh)
      }
    }
  }

  /** Turns named parts from their rest by the angles given (radians); parts not named go back to rest. */
  pose(poses: Record<string, Vec3> | null): void {
    for (const { def, group } of this.parts) {
      const add = poses?.[def.pose ?? def.name]
      group.rotation.set(def.rot[0] + (add?.[0] ?? 0), def.rot[1] + (add?.[1] ?? 0), def.rot[2] + (add?.[2] ?? 0), 'XYZ')
    }
  }

  /** The geometry belongs to the shared model: only the groups go. */
  dispose(): void {
    this.root.removeFromParent()
  }
}

/** A part a doctor wears: drawn finer and soft, painted as the doctor is. */
export const wornInstance = (recipe: Recipe) => new ModelInstance(recipe, wornMaterial(), GLOW, 'worn')

export const euler = new Euler()
