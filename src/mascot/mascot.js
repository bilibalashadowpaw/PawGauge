'use strict';
// Behaviour for the ShadowBlack perch. She always clings to the window edge in the peek pose at one fixed size;
// a small state machine (mood from usage, activity from the system idle timer) changes how she moves, with
// constrained randomness for idle actions and a reaction layer (cursor, clicks, wake-up).
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

const slot = document.getElementById('slot');
const rig = document.getElementById('rig');
const mover = document.getElementById('mover');
const tail = document.getElementById('tail');
const follow = document.getElementById('follow');

let mood = 'loading';
let night = false;
let idleState = 'awake'; // awake | drowsy | asleep (system-wide input idle time)
let busy = false;
let idleTimer = null;
let lastAction = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));

function playOnce(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// Resting posture: sinks a little when drowsy (or at night), slides down behind the edge when asleep.
function applyPosture() {
  const asleep = idleState === 'asleep';
  const drowsy = !asleep && (idleState === 'drowsy' || (mood === 'ok' && night));
  slot.classList.toggle('asleep', asleep);
  slot.classList.toggle('drowsy', drowsy);
}

let modeGen = 0; // bumped by every collapse/expand message; a newer one cancels whatever an older step still waits to do

async function peekaboo() {
  const gen = modeGen;
  busy = true;
  slot.classList.add('duck');
  await sleep(700);
  if (gen !== modeGen) return; // the window started collapsing or expanding: that handler owns 'duck' and 'busy' now
  slot.classList.remove('duck');
  await sleep(600);
  if (gen === modeGen) busy = false;
}

async function hop() {
  playOnce(mover, 'hop', 950);
  playOnce(tail, 'flick', 1000);
  await sleep(1000);
}

// Idle actions: weighted, never the same one twice in a row, only while she is awake.
const ACTIONS = {
  look: { weight: 3, run: async () => playOnce(mover, 'look', 2300) },
  flick: { weight: 3, run: async () => playOnce(tail, 'flick', 1000) },
  peekaboo: { weight: 1, run: peekaboo },
  hop: { weight: 1, run: hop },
};
function pickAction() {
  const pool = Object.entries(ACTIONS).filter(([k]) => k !== lastAction);
  const total = pool.reduce((n, [, a]) => n + a.weight, 0);
  let r = Math.random() * total;
  for (const [k, a] of pool) {
    r -= a.weight;
    if (r <= 0) return k;
  }
  return pool[0][0];
}
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (!busy && idleState === 'awake') {
      const k = pickAction();
      lastAction = k;
      await ACTIONS[k].run();
    }
    scheduleIdle();
  }, 15000 + Math.random() * 20000);
}

window.mascot.onMood(async (m) => {
  mood = m.mood;
  night = !!m.night;
  idleState = m.idle || 'awake';
  document.body.dataset.mood = mood;
  applyPosture();
  if (m.woke) {
    playOnce(rig, 'stretch', 1600); // wakes with a stretch when you come back
  } else if (m.refilled) {
    await hop(); // quota recovered
    await sleep(300);
    await hop();
  }
});

// Collapse / expand of the window she sits on. She ducks behind the edge while the window moves (nobody sees her
// float over empty space), then rises again: small on the collapsed pill, or full size with a stretch and a hop.
const stage = document.getElementById('stage');
window.mascot.onMode(async ({ mode, side }) => {
  if (mode === 'tucked' || mode === 'untucked') { // the window slid off the screen edge: only the side-peek sprite shows
    document.body.classList.toggle('docked', mode === 'tucked');
    document.body.classList.toggle('left', mode === 'tucked' && side === 'left');
    return;
  }
  const gen = ++modeGen;
  const stale = () => gen !== modeGen;
  if (mode === 'collapsing' || mode === 'expanding') {
    busy = true;
    slot.classList.add('duck');
  } else if (mode === 'collapsed') {
    stage.classList.add('mini');
    await sleep(80);
    if (stale()) return;
    slot.classList.remove('duck');
    await sleep(500);
    if (!stale()) busy = false;
  } else if (mode === 'expanded') {
    stage.classList.remove('mini');
    await sleep(80);
    if (stale()) return;
    slot.classList.remove('duck');
    await sleep(350);
    if (stale()) return;
    playOnce(rig, 'stretch', 1600);
    await hop();
    if (!stale()) busy = false;
  }
});

// Her head follows the cursor a little (the eyes are part of the art and are never touched).
window.mascot.onLook((dx) => {
  if (idleState === 'asleep') dx = 0;
  follow.style.setProperty('--lx', dx.toFixed(2));
});

// Click her: a hop. Every third click she also flicks her tail.
// Her sprites are images: without this a press plus a small move starts the browser's image drag and swallows the click.
document.addEventListener('dragstart', (e) => e.preventDefault());
let clickCount = 0;
// Act on the release, not on 'click'. Her window never takes focus, and on Windows Chromium can then swallow the button
// press (it answers WM_MOUSEACTIVATE with "eat it"): the page gets the release alone, so no 'click' ever fires.
document.addEventListener('pointerup', async (e) => {
  if (e.button !== 0) return;
  window.mascot.clicked(); // raises the whole window (and un-tucks it); never dropped because she is mid-animation
  if (busy || idleState === 'asleep') return;
  clickCount++;
  await hop();
});

scheduleIdle();
