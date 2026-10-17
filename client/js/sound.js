/* Ludo Master 3D — subtle synthesized sound effects (Web Audio API).
 * No audio files needed. Master gain is kept low (~0.2) so sounds stay
 * "halka" (subtle). Mute preference persists in localStorage.
 *
 * API: Sound.play('click'|'dice'|'move'|'capture'|'win'|'turn')
 *      Sound.muted() / Sound.setMuted(bool) / Sound.toggleMuted()
 */
(function () {
'use strict';

var MUTE_KEY = 'ludo_sound_muted';
var MASTER = 0.2;

var ctx = null;
var masterGain = null;
var muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}

function ensureCtx() {
  if (ctx) return ctx;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = MASTER;
  masterGain.connect(ctx.destination);
  return ctx;
}

// Browsers suspend AudioContext until a user gesture: resume on first touch.
function unlock() {
  var c = ensureCtx();
  if (c && c.state === 'suspended') {
    try { c.resume(); } catch (e) {}
  }
}
['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
  window.addEventListener(ev, unlock, { passive: true });
});

function tone(opts) {
  var c = ensureCtx();
  if (!c || muted) return;
  var t0 = c.currentTime + (opts.delay || 0);
  var osc = c.createOscillator();
  var g = c.createGain();
  osc.type = opts.type || 'sine';
  osc.frequency.setValueAtTime(opts.from, t0);
  if (opts.to && opts.to !== opts.from) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + opts.dur);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.vol || 0.5, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  osc.connect(g);
  g.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.05);
}

function noiseBurst(delay, dur, vol) {
  var c = ensureCtx();
  if (!c || muted) return;
  var t0 = c.currentTime + (delay || 0);
  var len = Math.max(1, Math.floor(c.sampleRate * dur));
  var buf = c.createBuffer(1, len, c.sampleRate);
  var d = buf.getChannelData(0);
  for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  var src = c.createBufferSource();
  src.buffer = buf;
  var g = c.createGain();
  g.gain.value = vol || 0.25;
  var f = c.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 2500;
  src.connect(f); f.connect(g); g.connect(masterGain);
  src.start(t0);
}

var SOUNDS = {
  // soft UI tap
  click: function () { tone({ from: 1150, to: 900, dur: 0.045, type: 'sine', vol: 0.28 }); },
  // dice rattle: a few quick ticks
  dice: function () {
    for (var i = 0; i < 5; i++) noiseBurst(i * 0.055, 0.04, 0.22);
    tone({ from: 500, to: 700, dur: 0.07, delay: 0.28, type: 'triangle', vol: 0.3 });
  },
  // token hop
  move: function () { tone({ from: 620, to: 940, dur: 0.09, type: 'sine', vol: 0.35 }); },
  // capture zap
  capture: function () {
    tone({ from: 820, to: 180, dur: 0.16, type: 'sawtooth', vol: 0.3 });
    tone({ from: 300, to: 900, dur: 0.1, delay: 0.1, type: 'square', vol: 0.14 });
  },
  // gentle turn chime
  turn: function () {
    tone({ from: 880, dur: 0.1, type: 'sine', vol: 0.3 });
    tone({ from: 1318, dur: 0.14, delay: 0.1, type: 'sine', vol: 0.28 });
  },
  // small win fanfare (C E G C)
  win: function () {
    var notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach(function (f, i) {
      tone({ from: f, dur: 0.22, delay: i * 0.13, type: 'triangle', vol: 0.42 });
      tone({ from: f * 2, dur: 0.18, delay: i * 0.13, type: 'sine', vol: 0.12 });
    });
  }
};

window.Sound = {
  play: function (name) {
    try {
      if (muted) return;
      unlock();
      var fn = SOUNDS[name];
      if (fn) fn();
    } catch (e) {}
  },
  muted: function () { return muted; },
  setMuted: function (m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
  },
  toggleMuted: function () {
    this.setMuted(!muted);
    return muted;
  }
};
})();
