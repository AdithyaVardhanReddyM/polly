// Where each face of the card sits in the model's texture atlas, as fractions
// of it: the front is the left half, the back the right (measured from
// card.glb). Kept apart from the 3D code so drawing a face does not load it.
export const FRONT = { x: 0, y: 0, w: 0.5, h: 0.755 }
export const BACK = { x: 0.5, y: 0, w: 0.5, h: 0.757 }

/** Width over height of a card face; draw face canvases in this shape. */
export const FACE_ASPECT = FRONT.w / FRONT.h
