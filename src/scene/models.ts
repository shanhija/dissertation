/**
 * Models as three.js: a recipe (shapes from the modelling kit) becomes merged geometry per part
 * through the builder in model/mesh.ts, drawn here in this game's own materials. A model is
 * built once per recipe and shared; an instance is a tree of groups, one per part, so a pose
 * turns a part with everything on it.
 */

import { Color, Euler, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector2, type Material } from 'three'

import type { PartDef } from '../model/kit'
import { buildModel, type Model } from '../model/mesh'
import type { Recipe, Vec3 } from '../protocol'
import { boxUV, surfaceMaps } from './materials'
import { PAINT_MODEL, harmonizeColors, paint } from './paint'

let solid: MeshStandardMaterial | null = null
/** Models' shapes: their own colours over a fine grain, a little shine. */
export function solidMaterial(): MeshStandardMaterial {
  if (!solid) {
    const { map, normal } = surfaceMaps('plaster')
    solid = paint(new MeshStandardMaterial({ vertexColors: true, map, normalMap: normal, normalScale: new Vector2(0.6, 0.6), roughness: 0.62, metalness: 0.05 }), PAINT_MODEL)
  }
  return solid
}

/** Glowing shapes: brighter than white, so the bloom catches them (the lighting tab scales it). */
export const GLOW_BASE = 1.7
export const GLOW = new MeshBasicMaterial({ vertexColors: true, color: new Color(GLOW_BASE, GLOW_BASE, GLOW_BASE) })

const built = new WeakMap<Recipe, Model>()

/** A model's geometry, built once per recipe, with texture coordinates for its grain (a tile per 0.4 m) and its colours brought into the painting's range. */
export function modelOf(recipe: Recipe): Model {
  let m = built.get(recipe)
  if (!m) {
    m = buildModel(recipe)
    for (const g of m.parts.values()) {
      if (g.solid) {
        boxUV(g.solid, 0.4)
        const c = g.solid.getAttribute('color')
        if (c) harmonizeColors(c)
      }
      const c = g.glow?.getAttribute('color')
      if (c) harmonizeColors(c, true)
    }
    built.set(recipe, m)
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
  ) {
    const model = modelOf(recipe)
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

export const euler = new Euler()
