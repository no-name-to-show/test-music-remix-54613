/**
 * MixMaker · Timeline geometry and waveform canvas renderer.
 */
export function getTimelineWidth(projectEnd, zoom, spacer) {
  return Math.max(60, projectEnd + 20) * zoom + spacer;
}

export function drawWaveform(canvas, peaks, from, to, reverse, style) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  const middle = height / 2;
  if (!peaks) {
    context.fillStyle = '#2a3350';
    context.fillRect(0, middle - 1, width, 2);
    return;
  }
  if (style === 'grad') {
    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#8b5cf6');
    gradient.addColorStop(1, '#22d3ee');
    context.fillStyle = gradient;
  } else {
    context.fillStyle = 'rgba(255,255,255,.72)';
  }
  const barWidth = 2;
  const gap = 1;
  const bars = Math.max(1, Math.floor(width / (barWidth + gap)));
  const count = peaks.length;
  for (let i = 0; i < bars; i++) {
    const p0 = Math.floor((from + (to - from) * i / bars) * count);
    const p1 = Math.max(p0 + 1, Math.floor((from + (to - from) * (i + 1) / bars) * count));
    let value = 0;
    for (let k = p0; k < Math.min(p1, count); k++) {
      const index = reverse ? count - 1 - k : k;
      if (peaks[index] > value) value = peaks[index];
    }
    const barHeight = Math.max(1.5, value * (height - 4));
    context.fillRect(i * (barWidth + gap), middle - barHeight / 2, barWidth, barHeight);
  }
}
