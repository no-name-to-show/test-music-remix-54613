/**
 * MixMaker · WAV serialization helpers.
 */
export function createWavHeader(frames, sampleRate) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const dataBytes = frames * 4;
  const put = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  put(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}
