/**
 * MixMaker · Clip model factory and timeline primitives.
 */
export const getClipEnd = clip => clip.start + clip.len;

export function createClipFactory({ uid, createDefaultEffects }) {
  function createClip(assetId, start, len, extra = {}) {
    return Object.assign({
      id: uid(), assetId, start, offset: 0, len, speed: 1,
      vol: 1, pan: 0, fadeIn: 0, fadeOut: 0,
      curve: 'smooth', reverse: false, fx: createDefaultEffects()
    }, extra);
  }
  return { createClip };
}
