/**
 * The page's type (fonts/, set up in styles.css): what is drawn into the 3D (name
 * tags, speech, crate labels, floating numbers, portrait plaques) is written in the same face as
 * the page around it. A canvas draws with whatever font has loaded by then, so the page waits for
 * them before it first draws (briefly: they come from the game's own server).
 */

export const LABEL_FONT = "'EB Garamond', 'Palatino Linotype', Palatino, Georgia, serif"

/** Resolves when the faces are in, or after a moment either way. */
export function fontsReady(): Promise<void> {
  const faces = ["600 30px 'EB Garamond'", "italic 500 30px 'EB Garamond'", "30px 'IM Fell English SC'", "30px 'IM Fell English'", "italic 30px 'IM Fell English'"]
  const all = Promise.all(faces.map((f) => document.fonts.load(f))).then(() => undefined)
  return Promise.race([all, new Promise<void>((done) => setTimeout(done, 1500))]).catch(() => undefined)
}
