/**
 * MixMaker · Track model factory
 * Keeps track defaults and identity generation out of the UI orchestration.
 */
export function createTrackFactory({ getTracks, uid, hues, createDefaultEffects }) {
  function createTrack(name) {
    const tracks = getTracks();
    const index = tracks.length;
    return {
      id: uid(),
      name: name || `Pista ${index + 1}`,
      hue: hues[index % hues.length],
      vol: 1, pan: 0, mute: false, solo: false,
      fx: createDefaultEffects(),
      clips: []
    };
  }
  return { createTrack };
}
