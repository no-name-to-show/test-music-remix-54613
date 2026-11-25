/**
 * MixMaker · Web Audio engine bootstrap.
 * Owns lazy AudioContext creation and the master analyser chain.
 */
export function createAudioContextManager(engineState) {
  function ensureContext() {
    if (engineState.ctx) return engineState.ctx;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Este navegador no soporta Web Audio API.');
    engineState.ctx = new AudioContextClass();
    engineState.master = engineState.ctx.createGain();
    engineState.an = engineState.ctx.createAnalyser();
    engineState.an.fftSize = 512;
    engineState.an.smoothingTimeConstant = 0.8;
    engineState.master.connect(engineState.an);
    engineState.an.connect(engineState.ctx.destination);
    return engineState.ctx;
  }
  return { ensureContext };
}
