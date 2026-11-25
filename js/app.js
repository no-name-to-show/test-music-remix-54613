import { createDefaultEffects, shapeEnvelope, createDistortionCurve } from './audio/effects.js';
import { createAudioContextManager } from './audio/engine.js';
import { createWavHeader } from './audio/export.js';
import { createTrackFactory } from './timeline/tracks.js';
import { createClipFactory, getClipEnd } from './timeline/clips.js';
import { drawWaveform, getTimelineWidth } from './timeline/renderer.js';
import { createUIFeedback } from './ui/controls.js';
import { initializeThemes } from './ui/themes.js';
import { renderInspectorField } from './ui/inspector.js';
import { createProjectDatabase, serializeProject } from './storage/project.js';

'use strict';
        (() => {
            /* =====================================================================
               MIX MAKER — editor multipista. Todo se procesa en el navegador.
               Secciones:
                 1. Utilidades        2. Modelo del proyecto     3. Historial (undo)
                 4. Biblioteca (carga de audio)
                 5. Motor de audio: envolventes, efectos, planificación
                 6. Render y exportación WAV
                 7. Reproducción       8. Interfaz: timeline, biblioteca, propiedades
                 9. Interacción        10. Persistencia (IndexedDB / JSON) y arranque
               ===================================================================== */

            /* ===== 1. UTILIDADES ===== */
            const $ = (s, r = document) => r.querySelector(s);
            const $$ = (s, r = document) => [...r.querySelectorAll(s)];
            const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
            const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
            const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
            const tick = () => new Promise(r => setTimeout(r, 0));
            const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
            const fmt = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), sec = s - m * 60; return `${m}:${sec.toFixed(1).padStart(4, '0')}`; };
            const safeName = n => (n || 'mix').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'mix';
            const baseName = n => n.replace(/\.[^.]+$/, '');
            const HUES = [265, 190, 20, 140, 330, 50, 215, 0, 285, 165];
            const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

            const { toast, announce } = createUIFeedback($);

            /* ===== 2. MODELO DEL PROYECTO =====
               asset: archivo cargado (buffer decodificado, no se serializa)
               track: { id, name, hue, vol, pan, mute, solo, fx, clips[] }
               clip:  { id, assetId, start, offset, len, speed, vol, pan, fadeIn, fadeOut, curve, reverse, fx }
                      start/len en segundos de timeline; offset en segundos del archivo original.
               fx:    { eq:[low,mid,high] dB, hp Hz, lp Hz, rev 0-1, delay 0-1, dlt s, dist 0-1, comp, radio, bypass } */
            const defFx = createDefaultEffects;
            const S = {
                name: 'Mi mix', assets: [], tracks: [], sel: null,   // sel: { type:'clip'|'track', id }
                cursor: 0, zoom: 80, snap: { on: true, grid: 0.5 }, trans: 'crossfade',
                dirty: false,
            };
            const trackOf = c => S.tracks.find(t => t.clips.includes(c));
            const findClip = id => { for (const t of S.tracks) { const c = t.clips.find(x => x.id === id); if (c) return { t, c }; } return null; };
            const assetOf = c => S.assets.find(a => a.id === c.assetId);
            const clipEnd = getClipEnd;
            const trackById = id => S.tracks.find(t => t.id === id);
            function projectEnd() {
                let e = 0; for (const t of S.tracks) for (const c of t.clips) e = Math.max(e, clipEnd(c));
                return e;
            }
            const { createTrack: newTrack } = createTrackFactory({
                getTracks: () => S.tracks, uid, hues: HUES, createDefaultEffects
            });
            const { createClip: newClip } = createClipFactory({ uid, createDefaultEffects });
            /* Duración efectiva: con transición "corte", el clip anterior se recorta al empezar el siguiente. */
            function effLen(c) {
                const t = trackOf(c); if (!t) return c.len;
                if (S.trans === 'crossfade') return c.len;
                let end = clipEnd(c);
                for (const p of t.clips) if (p !== c && p.start > c.start && p.start < end) end = p.start;
                return Math.max(0.001, end - c.start);
            }
            function sortTrack(t) { t.clips.sort((a, b) => a.start - b.start); }
            /* Solape con el clip siguiente de la misma pista (define la duración del crossfade). */
            function nextClipOf(c) {
                const t = trackOf(c); if (!t) return null;
                let n = null;
                for (const p of t.clips) if (p !== c && p.start > c.start && (!n || p.start < n.start)) n = p;
                return n;
            }
            function overlapNext(c) { const n = nextClipOf(c); return n ? Math.max(0, clipEnd(c) - n.start) : 0; }
            function setOverlapNext(c, v) {
                const n = nextClipOf(c); if (!n) return;
                const a = assetOf(c), s = c.speed;
                let L = n.start + v - c.start, dL = L - c.len;
                if (c.reverse) {                       // invertido: alargar por el final lee más audio anterior
                    let off = c.offset - dL * s;
                    if (off < 0) { L = c.len + c.offset / s; off = 0; }
                    c.offset = off;
                }
                if (a && !c.reverse) L = Math.min(L, (a.duration - c.offset) / s);
                c.len = Math.max(0.05, L);
            }

            /* ===== 3. HISTORIAL (deshacer / rehacer) ===== */
            const H = { past: [], future: [] };
            function checkpoint() {
                H.past.push(JSON.stringify(S.tracks)); if (H.past.length > 150) H.past.shift();
                H.future = [];
            }
            function restoreState(json) {
                S.tracks = JSON.parse(json);
                if (S.sel && !(S.sel.type === 'track' ? trackById(S.sel.id) : findClip(S.sel.id))) S.sel = null;
                afterChange();
            }
            function undo() { if (!H.past.length) return; H.future.push(JSON.stringify(S.tracks)); restoreState(H.past.pop()); announce('Deshecho'); }
            function redo() { if (!H.future.length) return; H.past.push(JSON.stringify(S.tracks)); restoreState(H.future.pop()); announce('Rehecho'); }
            function markDirty() { S.dirty = true; }

            /* ===== 4. BIBLIOTECA: CARGA Y DECODIFICACIÓN ===== */
            const OK_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|webm)$/i;
            const isAudio = f => (f.type || '').startsWith('audio/') || OK_EXT.test(f.name);
            const E = { ctx: null, master: null, an: null, playing: false, from: 0, until: null, t0: 0, srcs: [], tok: 0, ir: new WeakMap() };
            const { ensureContext: ensureCtx } = createAudioContextManager(E);
            function computePeaks(buf, bins = 800) {
                const out = new Float32Array(bins), N = buf.length, step = N / bins; let max = 0;
                for (let c = 0; c < buf.numberOfChannels; c++) {
                    const d = buf.getChannelData(c);
                    for (let i = 0; i < bins; i++) {
                        const s = Math.floor(i * step), e = Math.max(s + 1, Math.floor((i + 1) * step));
                        const stride = Math.max(1, Math.floor((e - s) / 96)); let m = 0;
                        for (let k = s; k < e; k += stride) { const v = Math.abs(d[k]); if (v > m) m = v; }
                        if (m > out[i]) out[i] = m;
                    }
                }
                for (let i = 0; i < bins; i++) if (out[i] > max) max = out[i];
                const peak = max;
                if (max > 0) for (let i = 0; i < bins; i++) out[i] /= max;
                return { peaks: out, peak };
            }
            async function decodeBlob(blob) {
                const ctx = ensureCtx();
                const ab = await blob.arrayBuffer();
                if (!ab.byteLength) throw new Error('empty');
                return new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
            }
            function setAssetBuffer(a, buf) {
                a.buffer = buf; a.rev = null; a.duration = buf.duration; a.missing = false;
                const { peaks, peak } = computePeaks(buf); a.peaks = peaks; a.peak = peak;
            }
            /* Añade archivos a la biblioteca. place: { trackId, t } para colocarlos además en el timeline. */
            async function addFiles(fileList, place) {
                const files = [...fileList];
                if (!files.length) return;
                try { ensureCtx(); } catch (e) { toast(e.message, 'error'); return; }
                const queue = [];
                for (const f of files) {
                    if (!isAudio(f)) { toast(`«${f.name}»: formato no admitido. Usa MP3, WAV, OGG o M4A.`, 'error'); continue; }
                    let a = S.assets.find(x => x.missing && x.fileName === f.name);
                    if (!a) {
                        a = { id: uid(), name: baseName(f.name), fileName: f.name, size: f.size, duration: 0, peaks: null, peak: 0, buffer: null, rev: null, missing: false };
                        S.assets.push(a);
                    }
                    a.loading = true; a.file = f; queue.push(a);
                }
                if (!queue.length) return;
                renderLibrary();
                let ok = 0;
                for (const a of queue) {
                    try {
                        setAssetBuffer(a, await decodeBlob(a.file));
                        a.loading = false; ok++;
                        if (place && queue.length === 1) addClipAt(a.id, place.trackId, place.t);
                    } catch (err) {
                        a.loading = false;
                        const bad = !a.duration;
                        if (bad) S.assets.splice(S.assets.indexOf(a), 1);
                        toast(`No se pudo leer «${a.fileName}»: formato no compatible con este navegador o archivo dañado.`, 'error');
                    }
                    renderLibrary(); await tick();
                }
                if (ok) {
                    if (place && queue.length > 1) toast('Varios archivos: se añadieron a la biblioteca. Arrástralos al timeline.', 'info');
                    if (!place || queue.length > 1) toast(`${ok} ${ok === 1 ? 'audio añadido' : 'audios añadidos'} a la biblioteca.`, 'ok');
                    announce(`${ok} audios añadidos`);
                    afterChange();
                }
            }
            /* Coloca un audio de la biblioteca como clip en una pista (crea pista si hace falta). */
            function addClipAt(assetId, trackId, t) {
                const a = S.assets.find(x => x.id === assetId); if (!a || !a.buffer) return;
                let T = trackById(trackId);
                checkpoint();
                if (!T) { T = newTrack(); S.tracks.push(T); }
                const c = newClip(a.id, Math.max(0, t), a.duration);
                T.clips.push(c); sortTrack(T);
                S.sel = { type: 'clip', id: c.id };
                afterChange();
                return c;
            }
            function removeAsset(id) {
                const a = S.assets.find(x => x.id === id); if (!a) return;
                if (S.tracks.some(t => t.clips.some(c => c.assetId === id))) {
                    toast(`«${a.name}» se usa en el timeline: elimina antes sus clips.`, 'error'); return;
                }
                S.assets = S.assets.filter(x => x.id !== id);
                afterChange();
            }

            /* ===== 5. MOTOR DE AUDIO ===== */
            const CURVE_RATE = 100; // puntos de envolvente por segundo
            const shape = (x, type) => (type === 'lin' ? x : type === 'exp' ? x * x : Math.sin(clamp(x, 0, 1) * Math.PI / 2));

            /* Fades efectivos: los fades manuales + el crossfade automático con clips vecinos. */
            function autoFades(c) {
                const t = trackOf(c); let fi = c.fadeIn, fo = c.fadeOut; const len = effLen(c);
                if (t && S.trans === 'crossfade') {
                    for (const p of t.clips) {
                        if (p === c) continue;
                        if (p.start < c.start && clipEnd(p) > c.start) fi = Math.max(fi, Math.min(clipEnd(p), clipEnd(c)) - c.start);
                        if (p.start > c.start && p.start < clipEnd(c)) fo = Math.max(fo, clipEnd(c) - p.start);
                    }
                }
                if (fi + fo > len) { const k = len / (fi + fo); fi *= k; fo *= k; }
                return { fi, fo, len };
            }
            /* Valores de ganancia en [a,b] (tiempo local del clip), muestreados para setValueCurveAtTime. */
            function envCurve(c, a, b) {
                const { fi, fo, len } = autoFades(c);
                const n = Math.max(2, Math.ceil((b - a) * CURVE_RATE) + 1), arr = new Float32Array(n);
                for (let k = 0; k < n; k++) {
                    const x = a + (b - a) * k / (n - 1);
                    let g = c.vol;
                    if (fi > 0 && x < fi) g *= shape(x / fi, c.curve);
                    if (fo > 0 && x > len - fo) g *= shape(1 - (x - (len - fo)) / fo, c.curve);
                    arr[k] = g;
                }
                return arr;
            }
            /* Efectos: EQ 3 bandas, filtros, reverb (respuesta generada), delay, distorsión, compresor, "radio". */
            function irFor(ctx) {
                let b = E.ir.get(ctx); if (b) return b;
                const n = Math.floor(ctx.sampleRate * 2.4);
                b = ctx.createBuffer(2, n, ctx.sampleRate);
                for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3); }
                E.ir.set(ctx, b); return b;
            }
            const distCurve = createDistortionCurve;
            function buildFx(ctx, input, fx, out) {
                if (!fx || fx.bypass) { input.connect(out); return; }
                let cur = input;
                const link = n => { cur.connect(n); cur = n; };
                const eqF = [250, 1000, 4000], eqT = ['lowshelf', 'peaking', 'highshelf'];
                fx.eq.forEach((g, i) => {
                    if (!g) return;
                    const f = ctx.createBiquadFilter(); f.type = eqT[i]; f.frequency.value = eqF[i]; f.gain.value = g;
                    if (i === 1) f.Q.value = 1;
                    link(f);
                });
                if (fx.hp > 20) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = fx.hp; link(f); }
                if (fx.lp < 19990) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = fx.lp; link(f); }
                if (fx.radio) { const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.9; link(f); }
                if (fx.dist > 0) { const w = ctx.createWaveShaper(); w.curve = distCurve(fx.dist); w.oversample = '2x'; link(w); }
                if (fx.comp) {
                    const d = ctx.createDynamicsCompressor();
                    d.threshold.value = -24; d.ratio.value = 4; d.knee.value = 30; d.attack.value = 0.003; d.release.value = 0.25;
                    link(d);
                }
                const sum = ctx.createGain();
                cur.connect(sum);
                if (fx.rev > 0) {
                    const cv = ctx.createConvolver(); cv.buffer = irFor(ctx);
                    const g = ctx.createGain(); g.gain.value = fx.rev;
                    cur.connect(cv); cv.connect(g); g.connect(sum);
                }
                if (fx.delay > 0) {
                    const dl = ctx.createDelay(2); dl.delayTime.value = clamp(fx.dlt, 0.05, 1.5);
                    const fb = ctx.createGain(); fb.gain.value = 0.4;
                    const wet = ctx.createGain(); wet.gain.value = fx.delay;
                    cur.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(sum);
                }
                sum.connect(out);
            }
            function revBuf(a) {
                if (a.rev) return a.rev;
                const b = a.buffer, r = ensureCtx().createBuffer(b.numberOfChannels, b.length, b.sampleRate);
                for (let ch = 0; ch < b.numberOfChannels; ch++) {
                    const s = b.getChannelData(ch), d = r.getChannelData(ch), N = s.length;
                    for (let i = 0; i < N; i++) d[i] = s[N - 1 - i];
                }
                a.rev = r; return r;
            }
            const audible = T => !T.mute && (!S.tracks.some(x => x.solo) || T.solo);

            /* Planifica el mix en cualquier contexto (en vivo u offline) para el rango [from, to).
               La posición de timeline "from" sucede en el instante t0 del contexto. */
            function scheduleMix(ctx, dest, from, to, t0, srcs) {
                for (const T of S.tracks) {
                    if (!audible(T)) continue;
                    const bus = ctx.createGain(); bus.gain.value = T.vol;
                    const tPan = ctx.createStereoPanner(); tPan.pan.value = clamp(T.pan, -1, 1);
                    const post = ctx.createGain();
                    buildFx(ctx, bus, T.fx, post);
                    post.connect(tPan); tPan.connect(dest);
                    for (const c of T.clips) {
                        const len = effLen(c);
                        const a = Math.max(from, c.start), b = Math.min(to, c.start + len);
                        if (b - a <= 0.001) continue;
                        const asset = assetOf(c); if (!asset || !asset.buffer) continue;
                        const buf = c.reverse ? revBuf(asset) : asset.buffer;
                        const consumed = len * c.speed;
                        const la = a - c.start, lb = b - c.start;
                        const srcStart = c.reverse
                            ? asset.duration - (c.offset + consumed) + la * c.speed
                            : c.offset + la * c.speed;
                        const src = ctx.createBufferSource();
                        src.buffer = buf; src.playbackRate.value = c.speed;
                        const env = ctx.createGain(); env.gain.value = 0;
                        env.gain.setValueCurveAtTime(envCurve(c, la, lb), t0 + (a - from), b - a);
                        const cPan = ctx.createStereoPanner(); cPan.pan.value = clamp(c.pan, -1, 1);
                        src.connect(env); env.connect(cPan); buildFx(ctx, cPan, c.fx, bus);
                        src.start(t0 + (a - from), clamp(srcStart, 0, buf.duration), (b - a) * c.speed);
                        if (srcs) srcs.push(src);
                    }
                }
            }

            /* ===== 6. RENDER Y EXPORTACIÓN WAV ===== */
            const wavHeader = createWavHeader;
            /* Render por bloques de 60 s con 4 s de margen a cada lado para no cortar las colas de reverb/delay. */
            async function renderWav(onProgress, isCancelled) {
                const ctx = ensureCtx(), sr = ctx.sampleRate, total = projectEnd();
                const CH = 60, PAD = 4, frames = Math.ceil(total * sr);
                const parts = [null]; let written = 0, clipped = 0;
                for (let off = 0; off < total - 1e-6; off += CH) {
                    if (isCancelled()) throw new Error('cancel');
                    const from = Math.max(0, off - PAD), to = Math.min(total, off + CH + PAD);
                    const oc = new OfflineAudioContext(2, Math.ceil((to - from) * sr), sr);
                    const master = oc.createGain(); master.connect(oc.destination);
                    scheduleMix(oc, master, from, to, 0, null);
                    const buf = await oc.startRendering();
                    const skip = Math.round((off - from) * sr);
                    const keep = Math.min(Math.round(CH * sr), frames - written, buf.length - skip);
                    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
                    const out = new Int16Array(keep * 2);
                    for (let i = 0; i < keep; i++) {
                        let a = L[skip + i], b = R[skip + i];
                        if (a > 1 || a < -1 || b > 1 || b < -1) clipped++;
                        a = clamp(a, -1, 1); b = clamp(b, -1, 1);
                        out[2 * i] = a < 0 ? a * 0x8000 : a * 0x7fff;
                        out[2 * i + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
                    }
                    parts.push(out.buffer); written += keep;
                    onProgress(Math.min(1, (off + CH) / total));
                    await tick();
                }
                parts[0] = wavHeader(written, sr);
                return { blob: new Blob(parts, { type: 'audio/wav' }), clipped };
            }

            /* ===== 8. INTERFAZ: BIBLIOTECA, TIMELINE, PROPIEDADES ===== */
            const $tl = () => $('#tlInner');
            const RULER_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
            const SPACER = 170;

            function afterChange() { markDirty(); renderAll(); scheduleRestart(); queueSave(); }
            function renderAll() {
                renderLibrary(); renderTimeline(); renderInspector(); updateSummary(); updateUndoButtons();
                $('#transSel').value = S.trans;
                updateTransport(true);
            }
            function updateSummary() {
                const n = S.tracks.reduce((a, t) => a + t.clips.length, 0);
                $('#summary').textContent = `${S.tracks.length} ${S.tracks.length === 1 ? 'pista' : 'pistas'} · ${n} ${n === 1 ? 'clip' : 'clips'} · ${fmt(projectEnd())}`;
            }
            function updateUndoButtons() {
                $('#btnUndo').disabled = !H.past.length; $('#btnRedo').disabled = !H.future.length;
            }

            /* ---- Biblioteca ---- */
            function renderLibrary() {
                const ul = $('#assets'); ul.textContent = '';
                if (!S.assets.length) {
                    const li = document.createElement('li'); li.className = 'hint';
                    li.textContent = 'Todavía no hay audios. Los que cargues aparecerán aquí; luego arrástralos al timeline.';
                    ul.append(li); return;
                }
                for (const a of S.assets) {
                    const li = document.createElement('li');
                    li.className = 'asset' + (a.loading ? ' loading' : '') + (a.missing ? ' missing' : '');
                    li.dataset.aid = a.id;
                    li.draggable = !!a.buffer;
                    const meta = a.loading ? 'Decodificando…' : a.missing ? `Falta «${a.fileName}»: arrástralo aquí para recuperarlo` : `${fmt(a.duration)}`;
                    li.innerHTML = `<div class="an"></div><div class="am"></div><canvas aria-hidden="true"></canvas>
      <div class="ab"><button type="button" data-lib="add" ${a.buffer ? '' : 'disabled'}>+ Al cursor</button>
      <button type="button" class="danger" data-lib="del">Quitar</button></div>`;
                    $('.an', li).textContent = a.name; $('.am', li).textContent = meta;
                    $('[data-lib="add"]', li).setAttribute('aria-label', `Añadir «${a.name}» al cursor`);
                    $('[data-lib="del"]', li).setAttribute('aria-label', `Quitar «${a.name}» de la biblioteca`);
                    ul.append(li);
                    const cv = $('canvas', li);
                    if (a.peaks) drawWave(cv, a.peaks, 0, 1, false, 'grad');
                }
            }

            /* ---- Forma de onda en canvas ---- */
            const drawWave = drawWaveform;

            /* ---- Timeline ---- */
            function timelineWidth() { return getTimelineWidth(projectEnd(), S.zoom, SPACER); }
            function renderTimeline() {
                const inner = $tl(); inner.textContent = '';
                const W = timelineWidth();
                inner.style.width = W + 'px';
                /* Regla */
                const rrow = document.createElement('div'); rrow.className = 'rrow';
                const sp = document.createElement('div'); sp.className = 'spacer'; rrow.append(sp);
                const ruler = document.createElement('div'); ruler.className = 'ruler'; ruler.id = 'ruler';
                ruler.style.width = (W - SPACER) + 'px';
                const step = RULER_STEPS.find(s => s * S.zoom >= 70) || 120;
                for (let t = 0; t * S.zoom < W - SPACER; t += step) {
                    const s = document.createElement('span');
                    s.style.left = (t * S.zoom) + 'px';
                    s.textContent = fmt(t);
                    ruler.append(s);
                }
                rrow.append(ruler); inner.append(rrow);

                if (!S.tracks.length) {
                    const row = document.createElement('div'); row.className = 'trow';
                    row.style.height = '120px'; row.style.width = W + 'px';
                    const msg = document.createElement('p'); msg.className = 'empty-tl';
                    msg.innerHTML = '<b>Arrastra tus canciones aquí</b><br>Pulsa <b>+ Pista</b> para crear una pista y suelta un audio de la biblioteca en ella.';
                    row.append(msg); inner.append(row);
                }
                for (const T of S.tracks) {
                    const row = document.createElement('div'); row.className = 'trow'; row.dataset.tid = T.id;
                    row.style.width = W + 'px';
                    const h = document.createElement('div'); h.className = 'thdr'; h.style.setProperty('--h', T.hue);
                    const selT = S.sel && S.sel.type === 'track' && S.sel.id === T.id;
                    h.innerHTML = `<div class="bar"></div>
      <input type="text" class="tname" aria-label="Nombre de la pista" maxlength="40" value="${esc(T.name)}" data-tname="${T.id}">
      <div class="row">
        <button type="button" class="tog2" data-tact="mute" aria-pressed="${T.mute}" aria-label="Silenciar ${esc(T.name)}">M</button>
        <button type="button" class="tog2 solo" data-tact="solo" aria-pressed="${T.solo}" aria-label="Solo ${esc(T.name)}">S</button>
        <button type="button" class="tog2" data-tact="sel" aria-pressed="${selT}" aria-label="Seleccionar pista ${esc(T.name)}">⚙</button>
        <button type="button" class="tog2" data-tact="del" aria-label="Eliminar pista ${esc(T.name)}">🗑</button>
      </div>`;
                    const lane = document.createElement('div'); lane.className = 'lane'; lane.dataset.tid = T.id;
                    lane.style.width = (W - SPACER) + 'px';
                    for (const c of T.clips) lane.append(clipEl(T, c));
                    row.append(h, lane); inner.append(row);
                }
                /* Cursor */
                const ph = document.createElement('div'); ph.className = 'ph'; ph.id = 'ph';
                ph.style.left = (SPACER + S.cursor * S.zoom) + 'px';
                inner.append(ph);
                /* Dibujo de ondas tras insertar en el DOM (necesitan tamaño) */
                for (const cv of $$('.clip canvas', inner)) {
                    const { t, c } = findClip(cv.parentElement.dataset.id) || {};
                    if (c) drawClipWave(cv, c);
                }
            }
            const justDropped = new Set();
            function clipEl(T, c) {
                const a = assetOf(c), el = document.createElement('div');
                const selC = S.sel && S.sel.type === 'clip' && S.sel.id === c.id;
                el.className = 'clip' + (selC ? ' sel' : '') + (audible(T) ? '' : ' muted');
                el.dataset.id = c.id;
                if (justDropped.delete(c.id)) el.classList.add('settle');
                el.style.left = (c.start * S.zoom) + 'px';
                el.style.width = Math.max(6, effLen(c) * S.zoom) + 'px';
                el.style.setProperty('--h', T.hue);
                el.tabIndex = 0; el.setAttribute('role', 'button');
                const nm = c.name || (a ? a.name : '(archivo no disponible)');
                el.setAttribute('aria-label', `Clip «${nm}», inicio ${fmt(c.start)}, duración ${fmt(effLen(c))}${c.reverse ? ', invertido' : ''}`);
                el.title = `${nm} · ${fmt(c.start)} → ${fmt(clipEnd(c))}`;
                el.innerHTML = `<canvas aria-hidden="true"></canvas><span class="cl"></span><i class="hd l" data-edge="l"></i><i class="hd r" data-edge="r"></i>`;
                $('.cl', el).textContent = (c.reverse ? '↺ ' : '') + nm + (c.speed !== 1 ? ` · ${c.speed}×` : '');
                return el;
            }
            function drawClipWave(cv, c) {
                const a = assetOf(c); if (!a || !a.peaks) return;
                const consumed = effLen(c) * c.speed;
                drawWave(cv, a.peaks, c.offset / a.duration, Math.min(1, (c.offset + consumed) / a.duration), c.reverse, 'plain');
            }

            /* ---- Propiedades ---- */
            const pctOut = v => `${v} %`;
            const CLIP_DEFS = [
                { k: 'name', label: 'Nombre', type: 'text', get: o => o.name || (assetOf(o) ? assetOf(o).name : ''), set: (o, v) => { o.name = v.slice(0, 60); } },
                { k: 'start', label: 'Inicio (s)', type: 'number', min: 0, step: 0.1, get: o => +o.start.toFixed(2), set: (o, v) => { o.start = Math.max(0, v); } },
                { k: 'len', label: 'Duración (s)', type: 'number', min: 0.05, step: 0.1, get: o => +o.len.toFixed(2), set: (o, v) => { const a = assetOf(o); const max = a ? (a.duration - o.offset) / o.speed : v; o.len = clamp(v, 0.05, max); } },
                { k: 'vol', label: 'Volumen', type: 'range', min: 0, max: 200, step: 1, get: o => Math.round(o.vol * 100), set: (o, v) => { o.vol = v / 100; }, out: pctOut },
                { k: 'pan', label: 'Paneo', type: 'range', min: -100, max: 100, step: 1, get: o => Math.round(o.pan * 100), set: (o, v) => { o.pan = v / 100; }, out: v => v === 0 ? 'centro' : v < 0 ? `${-v} % izq.` : `${v} % der.` },
                { k: 'speed', label: 'Velocidad', type: 'range', min: 0.25, max: 4, step: 0.05, get: o => o.speed, set: (o, v) => { o.speed = v; const a = assetOf(o); if (a) o.len = clamp(o.len, 0.05, (a.duration - o.offset) / v); }, out: v => `${(+v).toFixed(2)}×` },
                { k: 'fadeIn', label: 'Fade in (s)', type: 'range', min: 0, max: 10, step: 0.05, get: o => o.fadeIn, set: (o, v) => { o.fadeIn = v; }, out: v => `${(+v).toFixed(2)} s` },
                { k: 'fadeOut', label: 'Fade out (s)', type: 'range', min: 0, max: 10, step: 0.05, get: o => o.fadeOut, set: (o, v) => { o.fadeOut = v; }, out: v => `${(+v).toFixed(2)} s` },
                { k: 'curve', label: 'Curva fades', type: 'select', opts: [['smooth', 'Suave'], ['lin', 'Lineal'], ['exp', 'Exponencial']], get: o => o.curve, set: (o, v) => { o.curve = v; } },
                { k: 'reverse', label: 'Invertir', type: 'check', get: o => o.reverse, set: (o, v) => { o.reverse = v; } },
                { k: 'xfade', label: 'Crossfade con el siguiente (s)', type: 'range', min: 0, max: 12, step: 0.5, get: o => +overlapNext(o).toFixed(1), set: (o, v) => setOverlapNext(o, v), out: v => `${(+v).toFixed(1)} s` },
            ];
            const TRACK_DEFS = [
                { k: 'vol', label: 'Volumen', type: 'range', min: 0, max: 150, step: 1, get: o => Math.round(o.vol * 100), set: (o, v) => { o.vol = v / 100; }, out: pctOut },
                { k: 'pan', label: 'Paneo', type: 'range', min: -100, max: 100, step: 1, get: o => Math.round(o.pan * 100), set: (o, v) => { o.pan = v / 100; }, out: v => v === 0 ? 'centro' : v < 0 ? `${-v} % izq.` : `${v} % der.` },
            ];
            const fxd = (k, label, type, min, max, step, get, set, out, extra = {}) => Object.assign({ k, label, type, min, max, step, get: o => get(o.fx), set: (o, v) => set(o.fx, v), out }, extra);
            const FX_DEFS = [
                fxd('eqL', 'EQ graves', 'range', -12, 12, 0.5, f => f.eq[0], (f, v) => { f.eq[0] = v; }, v => `${v} dB`),
                fxd('eqM', 'EQ medios', 'range', -12, 12, 0.5, f => f.eq[1], (f, v) => { f.eq[1] = v; }, v => `${v} dB`),
                fxd('eqH', 'EQ agudos', 'range', -12, 12, 0.5, f => f.eq[2], (f, v) => { f.eq[2] = v; }, v => `${v} dB`),
                fxd('hp', 'Paso alto', 'range', 20, 1000, 10, f => f.hp, (f, v) => { f.hp = v; }, v => v <= 20 ? 'off' : `${v} Hz`),
                fxd('lp', 'Paso bajo', 'range', 500, 20000, 100, f => f.lp, (f, v) => { f.lp = v; }, v => v >= 19900 ? 'off' : `${v} Hz`),
                fxd('rev', 'Reverb', 'range', 0, 100, 1, f => Math.round(f.rev * 100), (f, v) => { f.rev = v / 100; }, pctOut),
                fxd('delay', 'Eco (mezcla)', 'range', 0, 100, 1, f => Math.round(f.delay * 100), (f, v) => { f.delay = v / 100; }, pctOut),
                fxd('dlt', 'Eco (tiempo)', 'range', 50, 1000, 10, f => Math.round(f.dlt * 1000), (f, v) => { f.dlt = v / 1000; }, v => `${v} ms`),
                fxd('dist', 'Distorsión', 'range', 0, 100, 1, f => Math.round(f.dist * 100), (f, v) => { f.dist = v / 100; }, pctOut),
                fxd('comp', 'Compresor', 'check', 0, 0, 0, f => f.comp, (f, v) => { f.comp = v; }, null),
                fxd('radio', 'Filtro radio / teléfono', 'check', 0, 0, 0, f => f.radio, (f, v) => { f.radio = v; }, null),
                fxd('bypass', 'Desactivar todos los efectos', 'check', 0, 0, 0, f => f.bypass, (f, v) => { f.bypass = v; }, null),
            ];
            const fieldHTML = (def, obj, pfx) => renderInspectorField(def, obj, pfx, esc);
            function renderInspector() {
                const box = $('#insp');
                const focusId = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : null;
                const sel = S.sel;
                if (!sel) {
                    box.innerHTML = `<p class="hint" style="margin:0">Selecciona un clip o una pista para ver y editar sus propiedades.</p>
      <p class="hint">Cursor: <b>${fmt(S.cursor)}</b>. Usa <kbd>S</kbd> para dividir el clip seleccionado en el cursor.</p>`;
                    return;
                }
                if (sel.type === 'clip') {
                    const f = findClip(sel.id); if (!f) { S.sel = null; return renderInspector(); }
                    const { t, c } = f, a = assetOf(c);
                    box.innerHTML = `<div class="ins">
      <p class="hint" style="margin:0">Pista <b>${esc(t.name)}</b> · archivo <b>${esc(a ? a.name : '—')}</b></p>
      <div class="sec"><h3>Clip</h3>${CLIP_DEFS.map(d => fieldHTML(d, c, 'c')).join('')}
        <div class="btns">
          <button type="button" data-act="split">Dividir en cursor (S)</button>
          <button type="button" data-act="dup">Duplicar (Ctrl+D)</button>
          <button type="button" data-act="norm">Normalizar</button>
          <button type="button" class="danger" data-act="delclip">Eliminar</button>
        </div></div>
      <div class="sec"><h3>Efectos del clip</h3>${FX_DEFS.map(d => fieldHTML(d, c, 'x')).join('')}
        <div class="btns"><button type="button" data-act="fxreset">Restablecer efectos</button></div></div>
    </div>`;
                } else {
                    const T = trackById(sel.id); if (!T) { S.sel = null; return renderInspector(); }
                    box.innerHTML = `<div class="ins">
      <div class="sec"><h3>Pista</h3>
        <div class="fl"><label for="f_tn">Nombre</label><input type="text" id="f_tn" maxlength="40" value="${esc(T.name)}" data-tname="${T.id}"><span></span></div>
        ${TRACK_DEFS.map(d => fieldHTML(d, T, 't')).join('')}
        <div class="btns">
          <button type="button" class="tog2" data-act="tmute" aria-pressed="${T.mute}">Silenciar (M)</button>
          <button type="button" class="tog2 solo" data-act="tsolo" aria-pressed="${T.solo}">Solo</button>
          <button type="button" class="danger" data-act="tdel">Eliminar pista</button>
        </div></div>
      <div class="sec"><h3>Efectos de la pista</h3>${FX_DEFS.map(d => fieldHTML(d, T, 'x')).join('')}
        <div class="btns"><button type="button" data-act="fxreset">Restablecer efectos</button></div></div>
    </div>`;
                }
                if (focusId) { const el = document.getElementById(focusId); if (el) el.focus(); }
            }

            /* ===== 7. REPRODUCCIÓN ===== */
            function playhead() {
                if (!E.playing || !E.ctx) return S.cursor;
                return clamp(E.from + (E.ctx.currentTime - E.t0), 0, E.until ?? projectEnd());
            }
            function stopSources() {
                E.srcs.forEach(s => { try { s.stop(); } catch { } try { s.disconnect(); } catch { } });
                E.srcs = [];
            }
            async function startPlayback(from, until) {
                const end = projectEnd();
                if (!end) { toast('Añade audio al timeline para reproducir.', 'info'); return; }
                let ctx; try { ctx = ensureCtx(); } catch (e) { toast(e.message, 'error'); return; }
                if (from === undefined) from = S.cursor;
                until = until === undefined ? null : until;
                const limit = until ?? end;
                if (from >= limit - 0.02) from = 0;
                const tok = ++E.tok;
                try { await ctx.resume(); } catch { }
                if (tok !== E.tok) return;
                stopSources();
                E.t0 = ctx.currentTime + 0.05; E.from = from; E.until = until; E.playing = true;
                scheduleMix(ctx, E.master, from, limit, E.t0, E.srcs);
                syncPlayButton(); startLoop();
            }
            function pausePlayback() {
                if (!E.playing) return;
                S.cursor = playhead();
                E.tok++; stopSources(); E.playing = false; E.until = null;
                syncPlayButton(); updateTransport(true);
            }
            function stopPlayback() {
                const back = E.playing ? E.from : 0;
                pausePlayback(); S.cursor = back; updateTransport(true);
            }
            function togglePlay() { if (E.playing) pausePlayback(); else startPlayback(S.cursor, null); }
            function setCursor(t) {
                S.cursor = Math.max(0, t);
                if (E.playing) startPlayback(S.cursor, E.until); else updateTransport(true);
            }
            let restartT = 0;
            function scheduleRestart() {
                if (!E.playing) return;
                clearTimeout(restartT);
                restartT = setTimeout(() => { if (E.playing) startPlayback(playhead(), E.until); }, 120);
            }
            function syncPlayButton() {
                const b = $('#bPlay');
                b.innerHTML = E.playing
                    ? '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
                    : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
                b.setAttribute('aria-label', E.playing ? 'Pausar' : 'Reproducir');
            }
            function updateTransport(force) {
                const end = projectEnd();
                if (E.playing && E.ctx && playhead() >= (E.until ?? end) - 0.01) {
                    const back = E.from; pausePlayback(); S.cursor = back;
                }
                const pos = playhead();
                if (E.playing) S.cursor = pos;
                $('#tTime').textContent = `${fmt(pos)} / ${fmt(end)}`;
                const hit = S.tracks.reduce((f, t) => f || t.clips.find(c => pos >= c.start && pos < clipEnd(c)), null);
                $('#nowName').textContent = hit ? (hit.name || (assetOf(hit) || {}).name || '') : '';
                const ph = $('#ph');
                if (ph) ph.style.left = (SPACER + pos * S.zoom) + 'px';
                if (E.playing) {
                    const wrap = $('#tlWrap'), x = SPACER + pos * S.zoom;
                    if (x > wrap.scrollLeft + wrap.clientWidth - 40 || x < wrap.scrollLeft + SPACER) wrap.scrollLeft = Math.max(0, x - 200);
                    if (E.an) {
                        const buf = new Float32Array(E.an.fftSize); E.an.getFloatTimeDomainData(buf);
                        let p = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
                        $('#vuBar').style.width = Math.min(100, p * 100) + '%';
                    }
                } else $('#vuBar').style.width = '0%';
                if (force) { /* repintado puntual ya realizado */ }
            }
            /* Visualizador animado */
            const viz = { h: new Float32Array(40), energy: 0 };
            function drawViz() {
                const cv = $('#viz'), dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, hh = cv.clientHeight;
                if (!w || !hh) return;
                if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
                const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, hh);
                let data = null;
                if (E.playing && E.an) { data = new Uint8Array(E.an.frequencyBinCount); E.an.getByteFrequencyData(data); }
                const N = viz.h.length, bw = w / N, g = c.createLinearGradient(0, 0, w, 0);
                g.addColorStop(0, '#8b5cf6'); g.addColorStop(1, '#22d3ee'); c.fillStyle = g;
                let energy = 0;
                for (let i = 0; i < N; i++) {
                    const target = data ? data[Math.floor(Math.pow(i / N, 1.5) * data.length * 0.7)] / 255 : 0;
                    viz.h[i] += (target - viz.h[i]) * (target > viz.h[i] ? 0.5 : 0.1);
                    energy += viz.h[i];
                    const bh = viz.h[i] * hh;
                    c.fillRect(i * bw + 1, hh - bh, Math.max(1, bw - 2), bh);
                }
                viz.energy = energy;
            }
            let raf = 0;
            function startLoop() { if (!raf) raf = requestAnimationFrame(frame); }
            function frame() {
                raf = 0;
                updateTransport();
                if (!reduceMotion) drawViz();
                if (E.playing || viz.energy > 0.02) startLoop();
            }

            /* ===== 9. INTERACCIÓN ===== */
            /* Clips: ops sobre el modelo */
            function splitAt(c, t) {
                const T = trackOf(c); if (!T) return;
                if (!(t > c.start + 0.05 && t < clipEnd(c) - 0.05)) { toast('El cursor debe estar dentro del clip, lejos de sus bordes.', 'info'); return; }
                checkpoint();
                const s = c.speed, k = (t - c.start) * s, lo = c.offset, hi = c.offset + c.len * s;
                const leftLen = t - c.start, rightLen = clipEnd(c) - t;
                let lB, rB;
                if (!c.reverse) { lB = [lo, lo + k]; rB = [lo + k, hi]; }
                else { lB = [hi - k, hi]; rB = [lo, hi - k]; }
                const right = JSON.parse(JSON.stringify(c));
                right.id = uid(); right.start = t; right.len = rightLen; right.offset = rB[0];
                right.fadeIn = 0; right.fadeOut = c.fadeOut;
                c.len = leftLen; c.offset = lB[0]; c.fadeOut = 0;
                if (c.reverse) c.len = leftLen;
                T.clips.push(right); sortTrack(T);
                S.sel = { type: 'clip', id: right.id };
                afterChange();
            }
            function duplicateClip(c) {
                const T = trackOf(c); if (!T) return;
                checkpoint();
                const copy = JSON.parse(JSON.stringify(c));
                copy.id = uid(); copy.start = clipEnd(c);
                T.clips.push(copy); sortTrack(T); S.sel = { type: 'clip', id: copy.id };
                afterChange();
            }
            function deleteClip(c) {
                const T = trackOf(c); if (!T) return;
                checkpoint();
                T.clips = T.clips.filter(x => x !== c);
                if (S.sel && S.sel.id === c.id) S.sel = null;
                afterChange();
                toast('Clip eliminado.', 'info', { label: 'Deshacer', fn: undo });
            }
            function selectedTrack() {
                if (!S.sel) return null;
                if (S.sel.type === 'track') return trackById(S.sel.id);
                const f = findClip(S.sel.id); return f ? f.t : null;
            }
            function addTrack() {
                checkpoint();
                const T = newTrack(); S.tracks.push(T); S.sel = { type: 'track', id: T.id };
                afterChange();
            }
            function deleteTrack(T) {
                checkpoint();
                S.tracks = S.tracks.filter(x => x !== T);
                if (S.sel && (S.sel.id === T.id || (S.sel.type === 'clip' && !findClip(S.sel.id)))) S.sel = null;
                afterChange();
                toast(`Pista «${T.name}» eliminada.`, 'info', { label: 'Deshacer', fn: undo });
            }
            function selectNoRender(sel) {
                S.sel = sel;
                $$('.clip').forEach(el => el.classList.toggle('sel', !!sel && sel.type === 'clip' && el.dataset.id === sel.id));
                $$('[data-tact="sel"]').forEach(b => b.setAttribute('aria-pressed', String(!!sel && sel.type === 'track' && b.closest('.trow').dataset.tid === sel.id)));
                renderInspector();
                if (sel && matchMedia('(max-width:1100px)').matches) $('#inspector').classList.add('open');
            }
            function normalizeClip(c) {
                const a = assetOf(c); if (!a || !a.peak) return;
                checkpoint();
                c.vol = clamp(0.9 / a.peak, 0, 2);
                afterChange();
            }

            /* Snap magnético: cursor, bordes de clips y cuadrícula. */
            function snapPoints(exId) {
                const pts = [S.cursor];
                for (const T of S.tracks) for (const c of T.clips) if (c.id !== exId) pts.push(c.start, clipEnd(c));
                return pts;
            }
            function snapTime(t, exId) {
                if (!S.snap.on) return t;
                const thr = 10 / S.zoom, g = S.snap.grid;
                let best = t, bd = thr;
                const gn = Math.round(t / g) * g;
                if (Math.abs(gn - t) < bd) { best = gn; bd = Math.abs(gn - t); }
                for (const p of snapPoints(exId)) { const dd = Math.abs(p - t); if (dd < bd) { best = p; bd = dd; } }
                return best;
            }
            function snapMove(s, len, exId) {
                const a = snapTime(s, exId), b = snapTime(s + len, exId) - len;
                const da = Math.abs(a - s), db = Math.abs(b - s);
                if (a !== s && (b === s || da <= db)) return a;
                if (b !== s) return b;
                return s;
            }
            function setZoom(z) {
                S.zoom = clamp(Math.round(z), 10, 400);
                $('#zoom').value = S.zoom;
                renderTimeline(); updateSummary(); updateTransport(true);
            }

            /* ---- Eventos del timeline (delegación) ---- */
            const inner = $('#tlInner');
            let drag = null;
            const haptic = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch { } };
            inner.addEventListener('pointerdown', e => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                const ruler = e.target.closest('.ruler');
                if (ruler) { const r = ruler.getBoundingClientRect(); setCursor((e.clientX - r.left) / S.zoom); return; }
                const el = e.target.closest('.clip');
                if (el) {
                    e.preventDefault();
                    const f = findClip(el.dataset.id); if (!f) return;
                    const edge = e.target.dataset.edge;
                    checkpoint();
                    selectNoRender({ type: 'clip', id: f.c.id });
                    drag = {
                        mode: edge === 'l' ? 'l' : edge === 'r' ? 'r' : 'move', el, T: f.t, c: f.c, sx: e.clientX, sy: e.clientY,
                        os: f.c.start, ol: f.c.len, oo: f.c.offset, moved: false, target: f.t.id
                    };
                    try { el.setPointerCapture(e.pointerId); } catch { }
                    return;
                }
                const lane = e.target.closest('.lane');
                if (lane) {
                    const r = lane.getBoundingClientRect();
                    selectNoRender({ type: 'track', id: lane.dataset.tid });
                    setCursor((e.clientX - r.left) / S.zoom);
                }
            });
            inner.addEventListener('pointermove', e => {
                if (!drag) return;
                const d = drag, c = d.c, s = c.speed, a = assetOf(c);
                if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
                d.moved = true;
                const dx = (e.clientX - d.sx) / S.zoom;
                if (!a) return;
                const dur = a.duration, rev = c.reverse;
                if (d.mode === 'move') {
                    const raw = Math.max(0, d.os + dx), sn = Math.max(0, snapMove(raw, d.ol, c.id));
                    const snapped = Math.abs(sn - raw) > 1e-9;
                    if (snapped && !d.snapped) haptic(8);
                    d.snapped = snapped;
                    c.start = sn;
                    d.el.classList.add('moving');
                    $$('.lane').forEach(l => {
                        const r = l.getBoundingClientRect();
                        const over = e.clientY >= r.top && e.clientY <= r.bottom;
                        l.classList.toggle('target', over);
                        if (over) d.target = l.dataset.tid;
                    });
                } else if (d.mode === 'l') {
                    let delta = snapTime(d.os + dx, c.id) - d.os;
                    const minD = Math.max(-d.os, rev ? -(dur - (d.oo + d.ol * s)) / s : -d.oo / s);
                    delta = clamp(delta, minD, d.ol - 0.05);
                    c.start = d.os + delta; c.len = d.ol - delta;
                    if (!rev) c.offset = d.oo + delta * s;
                } else {
                    let L = snapTime(d.os + d.ol + dx, c.id) - d.os;
                    const maxL = rev ? d.ol + d.oo / s : (dur - d.oo) / s;
                    L = clamp(L, 0.05, maxL);
                    c.len = L;
                    if (rev) c.offset = d.oo - (L - d.ol) * s;
                }
                d.el.style.left = (c.start * S.zoom) + 'px';
                d.el.style.width = Math.max(6, effLen(c) * S.zoom) + 'px';
                const cv = $('canvas', d.el); if (cv) drawClipWave(cv, c);
            });
            function finishDrag() {
                const d = drag; drag = null;
                $$('.lane.target').forEach(l => l.classList.remove('target'));
                if (!d) return;
                if (!d.moved) { H.past.pop(); renderInspector(); return; }
                if (d.mode === 'move' && d.target !== d.T.id) {
                    const T2 = trackById(d.target);
                    if (T2) { d.T.clips = d.T.clips.filter(x => x !== d.c); T2.clips.push(d.c); sortTrack(T2); }
                }
                sortTrack(d.T);
                justDropped.add(d.c.id); haptic(12);
                afterChange();
            }
            inner.addEventListener('pointerup', finishDrag);
            inner.addEventListener('pointercancel', finishDrag);

            /* Arrastrar audios desde la biblioteca o archivos del equipo sobre una pista */
            inner.addEventListener('dragover', e => {
                const types = [...(e.dataTransfer?.types || [])];
                const lane = e.target.closest('.lane');
                if (!lane || !(types.includes('text/x-mm-asset') || types.includes('Files'))) return;
                e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
                $$('.lane.target').forEach(l => { if (l !== lane) l.classList.remove('target'); });
                lane.classList.add('target');
            });
            inner.addEventListener('drop', e => {
                const lane = e.target.closest('.lane');
                $$('.lane.target').forEach(l => l.classList.remove('target'));
                if (!lane) return;
                e.preventDefault(); e.stopPropagation();
                const r = lane.getBoundingClientRect(), t = snapTime(Math.max(0, (e.clientX - r.left) / S.zoom), null);
                const aid = e.dataTransfer.getData('text/x-mm-asset');
                if (aid) addClipAt(aid, lane.dataset.tid, t);
                else if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files, { trackId: lane.dataset.tid, t });
            });

            /* Botones y nombres de pista (cabecera) */
            inner.addEventListener('click', e => {
                const b = e.target.closest('[data-tact]'); if (!b) return;
                const T = trackById(b.closest('.trow').dataset.tid); if (!T) return;
                const act = b.dataset.tact;
                if (act === 'mute') { checkpoint(); T.mute = !T.mute; afterChange(); }
                else if (act === 'solo') { checkpoint(); T.solo = !T.solo; afterChange(); }
                else if (act === 'sel') selectNoRender({ type: 'track', id: T.id });
                else if (act === 'del') deleteTrack(T);
            });
            inner.addEventListener('input', e => {
                const el = e.target.closest('[data-tname]'); if (!el) return;
                const T = trackById(el.dataset.tname); if (!T) return;
                T.name = el.value.slice(0, 40) || 'Pista'; markDirty(); queueSave();
            });
            inner.addEventListener('change', e => {
                if (e.target.closest('[data-tname]')) afterChange();
            });
            inner.addEventListener('wheel', e => {
                if (!e.ctrlKey) return;
                e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.15 : 0.87));
            }, { passive: false });

            /* ---- Menú contextual (clic derecho o pulsación larga) ---- */
            function showMenu(x, y, items) {
                document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
                const m = document.createElement('div'); m.className = 'ctxmenu'; m.setAttribute('role', 'menu');
                for (const [label, fn, cls] of items) {
                    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.setAttribute('role', 'menuitem');
                    if (cls) b.className = cls;
                    b.addEventListener('click', () => { m.remove(); fn(); });
                    m.append(b);
                }
                document.body.append(m);
                const r = m.getBoundingClientRect();
                m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
                m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
                m.querySelector('button').focus();
            }
            document.addEventListener('pointerdown', e => { if (!e.target.closest('.ctxmenu')) document.querySelectorAll('.ctxmenu').forEach(m => m.remove()); });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.ctxmenu').forEach(m => m.remove()); });
            inner.addEventListener('contextmenu', e => {
                const el = e.target.closest('.clip'); if (!el) return;
                e.preventDefault();
                const f = findClip(el.dataset.id); if (!f) return;
                const c = f.c;
                selectNoRender({ type: 'clip', id: c.id });
                showMenu(e.clientX, e.clientY, [
                    ['Dividir en el cursor (S)', () => splitAt(c, S.cursor)],
                    ['Duplicar (Ctrl+D)', () => duplicateClip(c)],
                    ['Invertir', () => { checkpoint(); c.reverse = !c.reverse; afterChange(); }],
                    ['Normalizar', () => normalizeClip(c)],
                    ['Eliminar', () => deleteClip(c), 'danger'],
                ]);
            });

            /* ---- Pellizco para hacer zoom (táctil) ---- */
            const touches = new Map(); let pinch = null;
            const tlw = $('#tlWrap');
            tlw.addEventListener('pointerdown', e => {
                if (e.pointerType !== 'touch') return;
                touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (touches.size === 2) {
                    const [a, b] = [...touches.values()];
                    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: S.zoom };
                    drag = null;
                }
            });
            tlw.addEventListener('pointermove', e => {
                if (!touches.has(e.pointerId)) return;
                touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (pinch && touches.size === 2) {
                    const [a, b] = [...touches.values()];
                    setZoom(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
                }
            });
            const endTouch = e => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
            tlw.addEventListener('pointerup', endTouch);
            tlw.addEventListener('pointercancel', endTouch);

            /* ---- Biblioteca ---- */
            $('#assets').addEventListener('click', e => {
                const b = e.target.closest('[data-lib]'); if (!b) return;
                const aid = b.closest('.asset').dataset.aid;
                if (b.dataset.lib === 'del') removeAsset(aid);
                else {
                    const T = selectedTrack() || S.tracks[0];
                    addClipAt(aid, T ? T.id : null, S.cursor);
                }
            });
            $('#assets').addEventListener('dragstart', e => {
                const li = e.target.closest('.asset'); if (!li || !li.draggable) return;
                e.dataTransfer.setData('text/x-mm-asset', li.dataset.aid);
                e.dataTransfer.effectAllowed = 'copy';
                li.classList.add('dragging');
            });
            document.addEventListener('dragend', () => { $$('.asset.dragging').forEach(l => l.classList.remove('dragging')); $$('.lane.target').forEach(l => l.classList.remove('target')); });

            /* ---- Propiedades ---- */
            let cpPending = false;
            const insp = $('#insp');
            insp.addEventListener('focusin', e => { if (e.target.dataset && e.target.dataset.d) cpPending = true; });
            insp.addEventListener('input', e => {
                const el = e.target;
                if (el.dataset.tname) { const T = trackById(el.dataset.tname); if (T) { T.name = el.value.slice(0, 40) || 'Pista'; markDirty(); queueSave(); } return; }
                if (!el.dataset.d) return;
                const [pfx, k] = el.dataset.d.split('|');
                const def = (pfx === 'c' ? CLIP_DEFS : pfx === 't' ? TRACK_DEFS : FX_DEFS).find(x => x.k === k);
                const owner = applyTo(pfx); if (!def || !owner) return;
                if (cpPending) { checkpoint(); cpPending = false; }
                const v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? +el.value : el.value;
                def.set(owner, v);
                const out = el.parentElement.querySelector('output'); if (out && def.out) out.textContent = def.out(v);
                markDirty(); queueSave();
                renderTimeline();
                updateSummary(); scheduleRestart();
            });
            insp.addEventListener('change', e => {
                if (e.target.dataset && e.target.dataset.d) { cpPending = false; afterChange(); }
                if (e.target.dataset && e.target.dataset.tname) afterChange();
            });
            function applyTo(pfx) {
                if (!S.sel) return null;
                if (pfx === 'c') { const f = S.sel.type === 'clip' ? findClip(S.sel.id) : null; return f ? f.c : null; }
                if (pfx === 't') return S.sel.type === 'track' ? trackById(S.sel.id) : null;
                if (S.sel.type === 'clip') { const f = findClip(S.sel.id); return f ? f.c : null; }
                return trackById(S.sel.id);
            }
            insp.addEventListener('click', e => {
                const b = e.target.closest('[data-act]'); if (!b) return;
                const act = b.dataset.act, c = S.sel && S.sel.type === 'clip' ? (findClip(S.sel.id) || {}).c : null;
                const T = selectedTrack();
                if (act === 'split') { if (c) splitAt(c, S.cursor); }
                else if (act === 'dup') { if (c) duplicateClip(c); }
                else if (act === 'norm') { if (c) normalizeClip(c); }
                else if (act === 'delclip') { if (c) deleteClip(c); }
                else if (act === 'fxreset') { const o = c || T; if (o) { checkpoint(); o.fx = defFx(); afterChange(); } }
                else if (act === 'tmute' && T) { checkpoint(); T.mute = !T.mute; afterChange(); }
                else if (act === 'tsolo' && T) { checkpoint(); T.solo = !T.solo; afterChange(); }
                else if (act === 'tdel' && T) deleteTrack(T);
            });

            /* ---- Transporte, zoom y exportación ---- */
            $('#bPlay').addEventListener('click', togglePlay);
            $('#bStop').addEventListener('click', stopPlayback);
            $('#zoom').addEventListener('input', e => setZoom(+e.target.value));
            $('#zIn').addEventListener('click', () => setZoom(S.zoom * 1.25));
            $('#zOut').addEventListener('click', () => setZoom(S.zoom / 1.25));
            $('#snapOn').addEventListener('change', e => { S.snap.on = e.target.checked; markDirty(); queueSave(); });
            $('#snapGrid').addEventListener('change', e => { S.snap.grid = +e.target.value; markDirty(); queueSave(); });
            $('#btnAddTrack').addEventListener('click', addTrack);
            $('#transSel').addEventListener('change', e => { S.trans = e.target.value; afterChange(); });
            $('#btnHelp').addEventListener('click', () => $('#dlgHelp').showModal());
            $('#btnUndo').addEventListener('click', undo);
            $('#btnRedo').addEventListener('click', redo);

            let exporting = false, cancelFlag = false, lastUrl = null;
            function downloadBlob(blob, name) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            }
            async function doExport() {
                if (exporting) return;
                if (!projectEnd()) { toast('Añade audio al timeline antes de exportar.', 'info'); return; }
                const bad = S.tracks.some(t => t.clips.some(c => { const a = assetOf(c); return !a || !a.buffer; }));
                if (bad) { toast('Hay clips sin audio (archivo faltante). Arrastra los originales a la biblioteca antes de exportar.', 'error'); return; }
                const total = projectEnd(), frames = Math.ceil(total * ensureCtx().sampleRate);
                if (frames * 4 + 44 > 4e9) { toast('El mix supera el límite de 4 GB del formato WAV. Acórtalo o divídelo.', 'error'); return; }
                pausePlayback();
                exporting = true; cancelFlag = false;
                $('#btnExport').disabled = true; $('#progBox').hidden = false;
                const t0 = performance.now(), prog = $('#prog'), txt = $('#progTxt');
                try {
                    const { blob, clipped } = await renderWav(p => {
                        prog.value = p * 100;
                        const el = (performance.now() - t0) / 1000;
                        txt.textContent = `Procesando… ${Math.round(p * 100)} %` + (p > 0.03 ? ` · quedan ~${fmt(el / p * (1 - p))}` : '');
                    }, () => cancelFlag);
                    const name = `${safeName(S.name)}.wav`;
                    downloadBlob(blob, name);
                    toast(`Mix exportado: ${name} (${(blob.size / 1048576).toFixed(1)} MB).`, 'ok');
                    announce('Exportación completada');
                    if (clipped) toast('Hay saturación (clipping) en parte del mix. Baja el volumen de algún clip o pista.', 'warn');
                } catch (err) {
                    if (err && err.message === 'cancel') toast('Exportación cancelada.', 'info');
                    else toast('Error al exportar: ' + (err && err.message || err), 'error');
                } finally {
                    exporting = false; $('#btnExport').disabled = false; $('#progBox').hidden = true;
                }
            }
            $('#btnExport').addEventListener('click', doExport);
            $('#btnCancel').addEventListener('click', () => { cancelFlag = true; });

            /* ---- Teclado ---- */
            document.addEventListener('keydown', e => {
                const t = e.target;
                if (document.querySelector('dialog[open]')) return;
                if (t.matches && t.matches('input:not([type=range]):not([type=checkbox]),select,textarea,[contenteditable]')) return;
                if (e.ctrlKey || e.metaKey) {
                    const k = e.key.toLowerCase();
                    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
                    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
                    else if (k === 'd') {
                        const c = S.sel && S.sel.type === 'clip' ? (findClip(S.sel.id) || {}).c : null;
                        if (c) { e.preventDefault(); duplicateClip(c); }
                    }
                    return;
                }
                if (e.altKey) return;
                const onRange = t.type === 'range';
                switch (e.key) {
                    case ' ': case 'Spacebar':
                        e.preventDefault(); togglePlay(); break;
                    case 's': case 'S': {
                        const c = S.sel && S.sel.type === 'clip' ? (findClip(S.sel.id) || {}).c : null;
                        if (c) splitAt(c, S.cursor);
                        else { const T = selectedTrack(); if (T) { const hit = T.clips.find(x => S.cursor > x.start + 0.05 && S.cursor < clipEnd(x) - 0.05); if (hit) splitAt(hit, S.cursor); else toast('No hay ningún clip en el cursor de esta pista.', 'info'); } }
                        break;
                    }
                    case 'Delete': case 'Backspace': {
                        if (S.sel && S.sel.type === 'clip') { const c = (findClip(S.sel.id) || {}).c; if (c) { e.preventDefault(); deleteClip(c); } }
                        else if (S.sel && S.sel.type === 'track') { const T = trackById(S.sel.id); if (T) { e.preventDefault(); deleteTrack(T); } }
                        break;
                    }
                    case 'ArrowLeft': case 'ArrowRight':
                        if (onRange) break;
                        e.preventDefault(); setCursor(S.cursor + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1)); break;
                    case 'Home': if (!onRange) { e.preventDefault(); setCursor(0); } break;
                    case '+': case '=': setZoom(S.zoom * 1.25); break;
                    case '-': case '_': setZoom(S.zoom / 1.25); break;
                }
            });

            /* ---- Carga de archivos (biblioteca y arrastre a la página) ---- */
            const drop = $('#drop'), fileInput = $('#fileInput'), overlay = $('#overlay');
            drop.addEventListener('click', () => fileInput.click());
            drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
            drop.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } });
            drop.addEventListener('dragleave', () => drop.classList.remove('over'));
            drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files, null); });
            fileInput.addEventListener('change', () => { addFiles(fileInput.files, null); fileInput.value = ''; });
            let depth = 0;
            const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
            window.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; overlay.classList.add('on'); } });
            window.addEventListener('dragleave', e => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('on'); } });
            window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
            window.addEventListener('drop', e => {
                if (!hasFiles(e)) return;
                depth = 0; overlay.classList.remove('on');
                if (e.target.closest && e.target.closest('.lane, #drop')) return;   // lo gestionan sus propios manejadores
                e.preventDefault(); addFiles(e.dataTransfer.files, null);
            });

            /* ===== 10. PERSISTENCIA (IndexedDB autoguardado + JSON) ===== */
            let saveT = 0;
            const { openDatabase } = createProjectDatabase();
            let db = null;
            async function openDB() { db = await openDatabase(); return db; }
            function setSaveState(msg, isErr) {
                const el = $('#saveState'); el.textContent = msg; el.style.color = isErr ? 'var(--danger)' : '';
            }
            const serialize = () => serializeProject(S);
            function queueSave() {
                markDirty(); setSaveState('Cambios sin guardar…');
                clearTimeout(saveT); saveT = setTimeout(saveNow, 1200);
            }
            async function saveNow() {
                clearTimeout(saveT);
                if (!S.dirty && db) return;
                try {
                    await openDB();
                    const data = serialize();
                    await new Promise((res, rej) => {
                        const tx = db.transaction(['state', 'files'], 'readwrite');
                        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('cancelado'));
                        tx.objectStore('state').put(data, 'current');
                        const fs = tx.objectStore('files');
                        for (const a of S.assets) if (a.file) fs.put({ blob: a.file, name: a.fileName }, a.id);
                        const ids = new Set(S.assets.map(a => a.id));
                        fs.getAllKeys().onsuccess = ev => { ev.target.result.forEach(k => { if (!ids.has(k)) fs.delete(k); }); };
                    });
                    S.dirty = false;
                    setSaveState('Guardado · ' + new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }));
                } catch (err) {
                    const quota = err && err.name === 'QuotaExceededError';
                    setSaveState('No se pudo guardar', true);
                    toast(quota ? 'No hay espacio suficiente en el navegador para guardar el proyecto.' : 'Error al guardar: ' + (err && err.message || err), 'error');
                }
            }
            /* Aplica datos de proyecto. Los archivos se recuperan después (por nombre o desde IndexedDB). */
            function applyProject(data, blobs) {
                pausePlayback();
                S.name = String(data.name || 'Mi mix').slice(0, 60);
                $('#projName').value = S.name;
                const tr = typeof data.trans === 'string' ? data.trans : 'crossfade';
                S.trans = tr === 'cut' ? 'cut' : 'crossfade';
                S.zoom = clamp(num(data.zoom, 80), 10, 400);
                $('#zoom').value = S.zoom;
                S.snap = { on: data.snap ? !!data.snap.on : true, grid: num(data.snap && data.snap.grid, 0.5) };
                $('#snapOn').checked = S.snap.on; $('#snapGrid').value = String(S.snap.grid);
                S.assets = (data.assets || []).map(a => ({ id: String(a.id), name: String(a.name || 'audio').slice(0, 120), fileName: String(a.fileName || a.name || ''), size: num(a.size), duration: Math.max(0, num(a.duration)), peaks: null, peak: 0, buffer: null, rev: null, missing: true }));
                S.tracks = (data.tracks || []).map(t => ({
                    id: String(t.id || uid()), name: String(t.name || 'Pista').slice(0, 40), hue: num(t.hue, 265), vol: clamp(num(t.vol, 1), 0, 3),
                    pan: clamp(num(t.pan), -1, 1), mute: !!t.mute, solo: !!t.solo, fx: Object.assign(defFx(), t.fx || {}),
                    clips: (t.clips || []).map(c => Object.assign(newClip(String(c.assetId), num(c.start), num(c.len, 1)), c, { id: String(c.id || uid()) })),
                }));
                S.sel = null; S.cursor = 0; H.past = []; H.future = [];
                renderAll();
                return S.assets.filter(a => blobs && blobs.has(a.id));
            }
            async function relinkFromBlobs(list, blobs) {
                for (const a of list) {
                    const rec = blobs.get(a.id); if (!rec) continue;
                    a.loading = true; renderLibrary();
                    try { a.file = rec.blob; setAssetBuffer(a, await decodeBlob(rec.blob)); }
                    catch { a.missing = true; }
                    a.loading = false; renderLibrary(); renderTimeline(); await tick();
                }
                if (list.some(a => a.missing)) toast('Algunos audios no se pudieron recuperar. Arrástralos de nuevo a la biblioteca.', 'warn');
            }
            async function loadAutosave() {
                try {
                    await openDB();
                    const data = await new Promise((res, rej) => { const r = db.transaction('state').objectStore('state').get('current'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
                    if (!data || data.app !== 'mix-maker') { setSaveState('Sin cambios'); return; }
                    const blobs = new Map();
                    await new Promise((res, rej) => {
                        const r = db.transaction('files').objectStore('files').openCursor();
                        r.onsuccess = () => { const cur = r.result; if (cur) { blobs.set(String(cur.key), cur.value); cur.continue(); } else res(); };
                        r.onerror = () => rej(r.error);
                    });
                    const list = applyProject(data, blobs);
                    await relinkFromBlobs(list, blobs);
                    S.dirty = false;
                    setSaveState('Proyecto restaurado');
                    if (S.assets.length) toast('Proyecto restaurado desde este navegador.', 'ok');
                } catch (err) {
                    setSaveState('Sin guardado automático', true);
                }
            }
            $('#projName').addEventListener('input', e => { S.name = e.target.value.slice(0, 60) || 'Mi mix'; queueSave(); });
            $('#btnExportJson').addEventListener('click', () => {
                downloadBlob(new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' }), `${safeName(S.name)}.mixmaker.json`);
                toast('Proyecto exportado. Contiene la mezcla, no el audio: guarda también tus archivos originales.', 'info');
            });
            $('#btnImportJson').addEventListener('click', () => $('#jsonInput').click());
            $('#jsonInput').addEventListener('change', async e => {
                const f = e.target.files[0]; e.target.value = ''; if (!f) return;
                let data;
                try { data = JSON.parse(await f.text()); } catch { toast('El archivo no es un JSON válido.', 'error'); return; }
                if (!data || data.app !== 'mix-maker' || !Array.isArray(data.tracks)) { toast('Este JSON no es un proyecto de Mix Maker.', 'error'); return; }
                if (data.version !== 2) { toast('Este proyecto usa un formato antiguo y no se puede importar.', 'error'); return; }
                applyProject(data, null); queueSave();
                toast('Proyecto importado (reemplaza el mix anterior). Arrastra los audios originales a la biblioteca para completarlo.', 'info');
            });
            let newArmed = 0;
            $('#btnNew').addEventListener('click', e => {
                const b = e.currentTarget;
                if (S.tracks.length && Date.now() - newArmed > 4000) {
                    newArmed = Date.now(); b.textContent = '¿Seguro? Pulsa otra vez';
                    setTimeout(() => { b.textContent = 'Nuevo'; }, 4000);
                    return;
                }
                newArmed = 0; b.textContent = 'Nuevo';
                applyProject({ name: 'Mi mix' }, null);
                S.assets = []; H.past = []; H.future = []; renderAll(); queueSave();
            });
            document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S.dirty) saveNow(); });
            window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

            initializeThemes($);

            /* ---- Hoja de propiedades en móvil ---- */
            $('#btnSheet').addEventListener('click', () => $('#inspector').classList.toggle('open'));
            $('#btnSheetClose').addEventListener('click', () => $('#inspector').classList.remove('open'));

            /* ---- Tutorial de primera visita ---- */
            $('#tipOk').addEventListener('click', () => { $('#tip').hidden = true; try { localStorage.setItem('mm-tip-seen', '1'); } catch { } });

            /* ===== ARRANQUE ===== */
            let tipSeen = true;
            try { tipSeen = !!localStorage.getItem('mm-tip-seen'); } catch { }
            $('#tip').hidden = tipSeen;
            renderAll();
            syncPlayButton();
            loadAutosave();
        })();
