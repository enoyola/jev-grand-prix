"use strict";
// Jev Grand Prix: the body. Track, physics, drawing, your car, and the loop that asks Jev.
// Jev never sees pixels. Several times a second the loop sends the car's telemetry to
// server.py, which turns it into words, asks Jev, and returns a racing line and a pedal
// choice. Jev is the race driver's brain (where to be, when to brake); code is the hands
// that turn the wheel to follow that line 120 times a second.

const CFG = {
  halfWidth: 7, // m: the track is 14 m wide
  vmax: 72, // m/s, about 260 km/h
  accel: 12, // m/s² at full throttle from low speed
  partAccel: 5,
  coastDecel: 3,
  brake: 18,
  hardBrake: 32,
  grip: 24, // m/s² of sideways grip; faster than this and the car slides wide
  grassDrag: 0.3, // extra drag on the grass, per m/s of speed
  crashDistance: 22, // m beyond the edge before the car is put back on track
  line: { left_edge: 5, left: 2.5, centre: 0, right: -2.5, right_edge: -5 }, // metres from centre, + is left
  maxSteer: 1 / 12, // tightest turn the wheels allow (12 m radius)
  playerSteer: 1 / 26,
  maxRaceSeconds: 600, // safety stop, so a forgotten tab can't keep spending
  zoom: 2.4, // screen pixels per metre
  carScale: 1.5, // draw cars a bit bigger than life so they're easy to see
};
const LINE_ORDER = ["left_edge", "left", "centre", "right", "right_edge"];
const PEDAL_ORDER = ["full_throttle", "part_throttle", "coast", "brake", "hard_brake"];
const PEDAL_COLOR = {
  full_throttle: "#2ecc71", part_throttle: "#9bd46a", coast: "#f1c40f", brake: "#e67e22", hard_brake: "#e74c3c",
};

// ---------------------------------------------------------------------------------------
// Track: a closed spline through these points (metres, y up), resampled every metre.
// ---------------------------------------------------------------------------------------

const CONTROL = [
  [-300, 0], [-150, 0], [0, 0], [150, 0], [290, 0],
  [360, -6], [398, -40], [405, -100],
  [398, -185], [375, -268], [322, -318], [245, -338],
  [160, -341], [125, -339], [95, -326], [62, -345], [22, -348],
  [-60, -346], [-150, -338], [-192, -305], [-183, -262], [-135, -249],
  [-78, -238], [-50, -200], [-46, -148], [-68, -104], [-115, -86],
  [-200, -83], [-275, -80], [-330, -62], [-356, -32], [-345, -6],
];

function catmull(p0, p1, p2, p3, t) {
  // Centripetal Catmull-Rom: smooth, and no loops or cusps at tight corners.
  const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4;
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => {
    const w = (u - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, t0, t2), mix(a2, a3, t1, t3), t1, t2);
}

const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function buildTrack(control) {
  const m = control.length, dense = [];
  for (let i = 0; i < m; i++) {
    const p = j => control[(i + j + m) % m];
    for (let s = 0; s < 40; s++) dense.push(catmull(p(-1), p(0), p(1), p(2), s / 40));
  }
  dense.push(dense[0]);

  const x = [dense[0][0]], y = [dense[0][1]];
  let since = 0; // metres from the last sample to the start of the current segment
  for (let i = 1; i < dense.length; i++) {
    const [ax, ay] = dense[i - 1], [bx, by] = dense[i];
    const seg = Math.hypot(bx - ax, by - ay);
    let d = 1 - since;
    for (; d <= seg; d += 1) {
      x.push(ax + (bx - ax) * (d / seg));
      y.push(ay + (by - ay) * (d / seg));
    }
    since = seg - (d - 1);
  }
  if (Math.hypot(x.at(-1) - x[0], y.at(-1) - y[0]) < 0.5) { x.pop(); y.pop(); }
  const n = x.length, at = i => (i + n) % n;

  const h = x.map((_, i) => Math.atan2(y[at(i + 1)] - y[at(i - 1)], x[at(i + 1)] - x[at(i - 1)]));
  const raw = h.map((_, i) => wrapAngle(h[at(i + 1)] - h[at(i - 1)]) / 2);
  const k = raw.map((_, i) => {
    let sum = 0;
    for (let j = -6; j <= 6; j++) sum += raw[at(i + j)];
    return sum / 13;
  });

  // Corners: stretches bending tighter than a 260 m radius, one direction at a time.
  const threshold = 1 / 260, start = k.findIndex(v => Math.abs(v) < threshold);
  let corners = [], cur = null;
  for (let j = 0; j <= n; j++) {
    const i = at(start + j), sign = Math.abs(k[i]) >= threshold ? Math.sign(k[i]) : 0;
    if (cur && sign === cur.sign) {
      cur.end = i; cur.len++;
      if (Math.abs(k[i]) > cur.maxK) { cur.maxK = Math.abs(k[i]); cur.apex = i; }
      continue;
    }
    if (cur) corners.push(cur);
    cur = sign ? { sign, start: i, end: i, len: 1, maxK: Math.abs(k[i]), apex: i } : null;
  }
  corners = corners.filter(c => c.len >= 8).sort((a, b) => a.start - b.start);
  corners.forEach((c, i) => {
    c.name = `Turn ${i + 1}`;
    c.short = `T${i + 1}`;
    c.dir = c.sign > 0 ? "left" : "right";
    c.radius = 1 / c.maxK;
    c.kind = c.radius < 25 ? "hairpin" : c.radius < 55 ? "sharp" : c.radius < 110 ? "medium" : "fast";
    c.limitKmh = Math.min(CFG.vmax, Math.sqrt(CFG.grip * c.radius)) * 3.6; // grip limit on the centre line
  });

  const path = new Path2D();
  x.forEach((_, i) => (i ? path.lineTo(x[i], y[i]) : path.moveTo(x[i], y[i])));
  path.closePath();
  const cornerPaths = corners.map(c => {
    const p = new Path2D();
    for (let j = 0, i = c.start; j < c.len; j++, i = at(i + 1)) (j ? p.lineTo(x[i], y[i]) : p.moveTo(x[i], y[i]));
    return p;
  });
  return { x, y, h, k, n, at, corners, path, cornerPaths };
}

const TRACK = buildTrack(CONTROL);
const ahead = (from, to) => (to - from + TRACK.n) % TRACK.n;
const inside = (c, i) => (c.start <= c.end ? i >= c.start && i <= c.end : i >= c.start || i <= c.end);

// ---------------------------------------------------------------------------------------
// Cars and physics
// ---------------------------------------------------------------------------------------

function makeCar(name, color, lateral) {
  const car = { name, color, lateral };
  resetCar(car);
  return car;
}

function resetCar(car) {
  const i = TRACK.n - 12; // on the grid, just behind the start line
  const nx = -Math.sin(TRACK.h[i]), ny = Math.cos(TRACK.h[i]);
  Object.assign(car, {
    idx: i, x: TRACK.x[i] + nx * car.lateral, y: TRACK.y[i] + ny * car.lateral, h: TRACK.h[i],
    v: 0, k: 0, cmd: { k: 0, line: "centre", pedal: "coast" }, lineOffset: car.lateral, offset: car.lateral, headingError: 0,
    brakeTarget: 0, lap: 1, lapStart: 0, laps: [], passedHalf: false, finished: false, finishTime: null,
    offTrack: false, offCount: 0, crashes: 0, sliding: false, trail: [], trailClock: 0,
  });
}

function pedalAccel(pedal, v) {
  const aero = 1 - (v / CFG.vmax) ** 2;
  switch (pedal) {
    case "full_throttle": return CFG.accel * aero;
    case "part_throttle": return CFG.partAccel * aero;
    case "brake": return -CFG.brake;
    case "hard_brake": return -CFG.hardBrake;
    default: return -CFG.coastDecel - 0.0006 * v * v;
  }
}

// The "hands": steer toward a point on the chosen line a little way up the road (pure pursuit).
function autoSteer(car, dt) {
  const want = CFG.line[car.cmd.line] ?? 0;
  car.lineOffset += clamp(want - car.lineOffset, -5 * dt, 5 * dt); // drift across smoothly, 5 m/s at most
  const look = clamp(car.v * 0.65, 12, 45);
  const i = TRACK.at(car.idx + Math.round(look)), th = TRACK.h[i];
  const tx = TRACK.x[i] - Math.sin(th) * car.lineOffset, ty = TRACK.y[i] + Math.cos(th) * car.lineOffset;
  const alpha = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.h);
  return clamp((2 * Math.sin(alpha)) / Math.max(Math.hypot(tx - car.x, ty - car.y), 5), -CFG.maxSteer, CFG.maxSteer);
}

function physics(car, dt) {
  const cmd = car.finished ? { ...car.cmd, k: 0, pedal: "brake" } : car.cmd;
  const target = car === you ? cmd.k : autoSteer(car, dt);
  car.k += (target - car.k) * Math.min(1, dt / 0.08); // the wheel moves smoothly, not instantly
  let a = pedalAccel(cmd.pedal, car.v);
  // Brake-by-wire: Jev decides when to brake; the car stops braking at the corner's speed.
  if (car === jev && !car.finished && cmd.pedal.includes("brake") && car.v <= car.brakeTarget) a = Math.max(a, 0);
  if (car.offTrack) a -= 1 + CFG.grassDrag * car.v;
  car.v = Math.max(0, Math.min(CFG.vmax, car.v + a * dt));

  // More sideways force than the tyres can give: the car slides wide (understeer).
  const grip = CFG.grip * (car.offTrack ? 0.5 : 1);
  const kMax = grip / Math.max(car.v * car.v, 1);
  let k = car.k;
  car.gripUsed = (car.v * car.v * Math.abs(k)) / grip; // 1.0 = exactly at the limit
  car.sliding = Math.abs(k) > kMax * 1.02;
  if (car.sliding) {
    k = Math.sign(k) * kMax;
    car.v = Math.max(0, car.v - 4 * dt);
  }
  if (car === jev && !car.finished) takeNotes(car, dt);
  car.h = wrapAngle(car.h + car.v * k * dt);
  car.x += car.v * Math.cos(car.h) * dt;
  car.y += car.v * Math.sin(car.h) * dt;
  locate(car);

  car.trailClock += dt;
  if (car.trailClock > 0.08) {
    car.trailClock = 0;
    car.trail.push({ x: car.x, y: car.y, pedal: cmd.pedal });
    if (car.trail.length > 700) car.trail.shift();
  }
}

function locate(car) {
  // Nearest centre-line point, searching near where the car was.
  let best = car.idx, bestD = Infinity;
  for (let j = -25; j <= 90; j++) {
    const i = TRACK.at(car.idx + j), d = (TRACK.x[i] - car.x) ** 2 + (TRACK.y[i] - car.y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  const prev = car.idx;
  car.idx = best;
  const th = TRACK.h[best];
  car.offset = -(car.x - TRACK.x[best]) * Math.sin(th) + (car.y - TRACK.y[best]) * Math.cos(th); // + is left
  car.headingError = wrapAngle(car.h - th);
  const wasOff = car.offTrack;
  car.offTrack = Math.abs(car.offset) > CFG.halfWidth + 0.5;
  if (car.offTrack && !wasOff) {
    car.offCount++;
    if (car === jev) {
      const c = TRACK.corners.find(c => inside(c, best))
        || (car.lastCorner && ahead(car.lastCorner.end, best) < 80 ? car.lastCorner : null);
      if (c) engineer.notes[c.name].off = true;
    }
  }

  if (Math.abs(car.offset) > CFG.halfWidth + CFG.crashDistance) {
    // Too far off: put the car back on the track, slowly, like a marshal would.
    Object.assign(car, { x: TRACK.x[best], y: TRACK.y[best], h: th, v: 12, k: 0, offset: 0, lineOffset: 0, headingError: 0, offTrack: false });
    car.crashes++;
  }

  const n = TRACK.n;
  if (best > n * 0.45 && best < n * 0.55) car.passedHalf = true;
  if (prev > n * 0.8 && best < n * 0.2 && car.passedHalf) {
    car.laps.push(game.t - car.lapStart);
    car.lapStart = game.t;
    car.passedHalf = false;
    car.lap++;
    if (car.lap > game.lapsTotal) { car.finished = true; car.finishTime = game.t; }
    if (car === jev) debrief(car);
  }
}

// What the car "sees": plain numbers. server.py turns these into words for Jev.
function observe(car) {
  const n = TRACK.n, look = Math.max(20, Math.min(70, car.v * 1.0));
  let sum = 0;
  for (let j = 5; j < 5 + look; j++) sum += TRACK.k[TRACK.at(car.idx + j)];
  const kAhead = sum / look;

  let corner = TRACK.corners.find(c => inside(c, car.idx) && ahead(car.idx, c.end) > 15);
  const isInside = !!corner;
  if (!corner) {
    corner = TRACK.corners
      .filter(c => !inside(c, car.idx))
      .sort((a, b) => ahead(car.idx, a.start) - ahead(car.idx, b.start))[0];
  }
  const toApex = ahead(corner.start, corner.apex);
  const phase = isInside
    ? (ahead(corner.start, car.idx) < toApex ? "turn_in" : "exit")
    : ahead(car.idx, corner.start) < Math.max(80, car.v * 2.2) ? "approach" : "straight";
  const target = targetKmh(corner);
  car.brakeTarget = target / 3.6;
  return {
    speed_kmh: car.v * 3.6,
    offset_m: car.offset,
    half_width_m: CFG.halfWidth,
    off_track: car.offTrack,
    heading_error_deg: (car.headingError * 180) / Math.PI,
    ahead: { radius_m: Math.abs(kAhead) < 1e-5 ? 99999 : 1 / Math.abs(kAhead), dir: kAhead > 0 ? "left" : "right" },
    corner: {
      name: corner.name, dir: corner.dir, kind: corner.kind, target_kmh: target, plan: levelOf(corner),
      inside: isInside, phase,
      distance_m: isInside ? 0 : ahead(car.idx, corner.start), remaining_m: isInside ? ahead(car.idx, corner.end) : 0,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Race engineer. Jev has no memory, so the code keeps notes on every corner and, at the
// end of each lap, asks Jev to plan how hard to push each corner on the next one.
// ---------------------------------------------------------------------------------------

// Corner target speed as a share of the grip limit the code *calculates* from the centre
// line. Laps start at "attack" (100%, the formula's limit). The racing line makes corners
// gentler than the centre line, so the true limit is higher; the engineer lets Jev find it.
// Levels are named by their percentage. Words like "maximum" read as "the top" to Jev.
const PUSH = Object.fromEntries([80, 87, 94, 100, 106, 112, 118, 124, 130].map(p => [`${p}%`, p / 100]));
const LEVELS = Object.keys(PUSH); // slowest to fastest
const START_LEVEL = "100%";
const levelOf = corner => engineer.plan[corner.name] || START_LEVEL;
const engineer = { plan: {}, steps: {}, history: {}, notes: {}, planConfidence: {}, requests: 0 };

const SECTOR_LEAD = 60; // metres of braking zone counted as part of each corner's sector
const blankNotes = () => Object.fromEntries(TRACK.corners.map(c => [c.name, { time: 0, grip: 0, slid: 0, off: false }]));
const targetKmh = corner => corner.limitKmh * PUSH[levelOf(corner)];

function resetEngineer() {
  Object.assign(engineer, { plan: {}, steps: {}, history: {}, notes: blankNotes(), planConfidence: {} });
}

function takeNotes(car, dt) {
  for (const c of TRACK.corners) {
    const inCorner = inside(c, car.idx);
    if (!inCorner && ahead(car.idx, c.start) > SECTOR_LEAD) continue;
    const note = engineer.notes[c.name];
    note.time += dt; // sector time: braking zone + corner
    if (!inCorner) continue;
    note.grip = Math.max(note.grip, car.gripUsed);
    if (car.sliding) note.slid += dt;
    car.lastCorner = c;
  }
}

function debrief(car) {
  const lap = car.laps.length;
  for (const c of TRACK.corners) {
    const note = engineer.notes[c.name];
    (engineer.history[c.name] ||= []).push({
      lap, push: levelOf(c), time: Math.round(note.time * 100) / 100,
      grip: Math.round(Math.min(note.grip, 1.2) * 100), slid: note.slid > 0.3, off: note.off,
    });
  }
  engineer.notes = blankNotes();
  if (!car.finished) requestPlan(lap + 1);
  renderEngineer();
}

async function requestPlan(lap) {
  if (lap === 1) return; // nothing to go on yet: every corner starts at START_LEVEL
  const corners = TRACK.corners.map(c => ({
    name: c.name, dir: c.dir, kind: c.kind, level: levelOf(c), history: engineer.history[c.name] || [],
  }));
  try {
    const response = await fetch("/api/plan", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lap, corners, levels: LEVELS }),
    });
    const d = await response.json();
    if (!response.ok) throw new Error(d.error || `HTTP ${response.status}`);
    // Jev says faster / same / slower per corner; code moves one level along the ladder.
    engineer.plan = Object.fromEntries(corners.map(c => {
      const i = LEVELS.indexOf(c.level) + ({ faster: 1, slower: -1 }[d.steps[c.name]] ?? 0);
      return [c.name, LEVELS[clamp(i, 0, LEVELS.length - 1)]];
    }));
    engineer.steps = d.steps;
    engineer.planConfidence = d.confidence;
    engineer.requests++;
    game.tokens += d.tokens;
    game.cost += d.cost;
    renderEngineer();
  } catch (error) {
    showError(`Lap plan failed, keeping the old plan: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------
// Game state, the Jev loop, and your car
// ---------------------------------------------------------------------------------------

const jev = makeCar("JEV", "#19c3b0", 3);
const you = makeCar("YOU", "#e8412c", -3);
const game = {
  state: "idle", t: 0, speed: 1, lapsTotal: 3, playerActive: false, follow: "jev", loopRunning: false,
  decisions: 0, tokens: 0, cost: 0, latencyAvg: null, recent: [], last: null, model: "",
};
window.game = game; // handy for poking at from the browser console
window.cars = { jev, you };

const keys = new Set();
addEventListener("keydown", e => {
  if (e.key.startsWith("Arrow")) { keys.add(e.key); e.preventDefault(); }
  if (e.key === "c" || e.key === "C") game.follow = game.follow === "jev" ? "you" : "jev";
});
addEventListener("keyup", e => keys.delete(e.key));

function playerCommand() {
  const steer = (keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0);
  const pedal = keys.has("ArrowDown") ? "hard_brake" : keys.has("ArrowUp") ? "full_throttle" : "coast";
  return { k: steer * CFG.playerSteer, pedal };
}

async function jevLoop() {
  if (game.loopRunning) return;
  game.loopRunning = true;
  try {
    while (game.state === "racing" && !jev.finished) {
      if (document.hidden) { // nobody's watching: stop asking (and paying)
        setState("paused");
        break;
      }
      const response = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(observe(jev)),
      });
      const d = await response.json();
      if (!response.ok) throw new Error(d.error || `HTTP ${response.status}`);
      if (game.state !== "racing") break;
      jev.cmd = { line: d.line, pedal: d.pedals };
      recordDecision(d);
    }
  } catch (error) {
    showError(`Jev request failed: ${error.message}`);
    setState("paused");
  } finally {
    game.loopRunning = false;
  }
}

function recordDecision(d) {
  game.decisions++;
  game.tokens += d.tokens;
  game.cost += d.cost;
  game.model = d.model;
  game.latencyAvg = game.latencyAvg == null ? d.latency_ms : game.latencyAvg * 0.85 + d.latency_ms * 0.15;
  const now = performance.now();
  game.recent.push(now);
  while (game.recent.length && now - game.recent[0] > 5000) game.recent.shift();
  game.last = d;
  renderBrain(d);
}

function step(dt) {
  game.t += dt;
  if (game.playerActive) you.cmd = playerCommand();
  physics(jev, dt);
  if (game.playerActive) physics(you, dt);
  const everyoneDone = jev.finished && (!game.playerActive || you.finished);
  if (everyoneDone || game.t > CFG.maxRaceSeconds) finishRace(game.t > CFG.maxRaceSeconds);
}

// ---------------------------------------------------------------------------------------
// Race flow: lights, pause, finish
// ---------------------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const lightsEl = $("lights"), bannerEl = $("banner");

function setState(state) {
  game.state = state;
  $("pause").textContent = state === "paused" ? "Resume" : "Pause";
  $("pause").disabled = !(state === "racing" || state === "paused");
  $("start").textContent = state === "idle" || state === "done" ? "Start race" : "Restart";
  if (state === "racing") jevLoop();
}

let lightsTimer = null;
function startRace() {
  clearTimeout(lightsTimer);
  game.lapsTotal = Number($("laps").value);
  game.speed = Number($("speed").value);
  game.playerActive = $("player").checked;
  game.follow = game.playerActive ? "you" : "jev";
  Object.assign(game, { t: 0, decisions: 0, tokens: 0, cost: 0, latencyAvg: null, recent: [], last: null });
  resetCar(jev);
  resetCar(you);
  resetEngineer();
  renderEngineer();
  requestPlan(1);
  showError("");
  banner("");
  setState("lights");

  // Five red lights, one every 0.6 s, then a random pause, then lights out.
  const spans = [...lightsEl.children];
  spans.forEach(s => s.classList.remove("on"));
  lightsEl.hidden = false;
  let lit = 0;
  const next = () => {
    if (game.state !== "lights") return;
    if (lit < 5) {
      spans[lit++].classList.add("on");
      lightsTimer = setTimeout(next, 600);
    } else {
      lightsTimer = setTimeout(() => {
        if (game.state !== "lights") return;
        spans.forEach(s => s.classList.remove("on"));
        banner("LIGHTS OUT AND AWAY WE GO!", 1600);
        setTimeout(() => (lightsEl.hidden = true), 400);
        setState("racing");
      }, 400 + Math.random() * 900);
    }
  };
  lightsTimer = setTimeout(next, 500);
}

function finishRace(timeLimit) {
  setState("done");
  const total = car => (car.finished ? fmt(car.finishTime) : "DNF");
  const best = car => (car.laps.length ? fmt(Math.min(...car.laps)) : "–");
  let text = `JEV  ${total(jev)}  · best lap ${best(jev)}`;
  if (game.playerActive) {
    text += `\nYOU  ${total(you)}  · best lap ${best(you)}`;
    const winner =
      jev.finished && (!you.finished || jev.finishTime < you.finishTime) ? "JEV WINS" : you.finished ? "YOU WIN!" : "";
    if (winner) text = `${winner}\n${text}`;
  } else {
    text = `CHEQUERED FLAG\n${text}`;
  }
  if (timeLimit) text += "\n(stopped at the 5-minute safety limit)";
  banner(text);
}

$("start").onclick = startRace;
$("pause").onclick = () => setState(game.state === "paused" ? "racing" : "paused");
$("speed").onchange = e => (game.speed = Number(e.target.value));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && game.state === "racing") setState("paused"); // don't spend while nobody's watching
});

function banner(text, ms) {
  bannerEl.textContent = text;
  bannerEl.hidden = !text;
  if (ms) setTimeout(() => bannerEl.textContent === text && (bannerEl.hidden = true), ms);
}

function showError(text) {
  $("error").textContent = text;
  $("error").hidden = !text;
}

// ---------------------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------------------

const LABEL = {
  left_edge: "far left", left: "left", centre: "centre", right: "right", right_edge: "far right",
  full_throttle: "full throttle", part_throttle: "part throttle", coast: "coast", brake: "brake", hard_brake: "hard brake",
};

function buildBars(el, order) {
  el.innerHTML = order
    .map(o => `<div class="bar" data-o="${o}"><span>${LABEL[o]}</span><i><b></b></i><em>–</em></div>`)
    .join("");
}
buildBars($("lineBars"), LINE_ORDER);
buildBars($("pedalBars"), PEDAL_ORDER);

function fillBars(el, probabilities, chosen) {
  for (const row of el.children) {
    const p = probabilities[row.dataset.o] ?? 0;
    row.querySelector("b").style.width = `${(p * 100).toFixed(1)}%`;
    row.querySelector("em").textContent = p.toFixed(2);
    row.classList.toggle("chosen", row.dataset.o === chosen);
  }
}

function renderBrain(d) {
  fillBars($("lineBars"), d.line_probabilities, d.line);
  fillBars($("pedalBars"), d.pedals_probabilities, d.pedals);
  $("conf").textContent = `confidence ${d.confidence.toFixed(2)}`;
  $("worry").style.width = `${(d.trouble * 100).toFixed(0)}%`;
  $("worry").style.background = d.trouble > 0.5 ? "#e74c3c" : d.trouble > 0.2 ? "#f1c40f" : "#2ecc71";
  $("worryVal").textContent = d.trouble.toFixed(2);
  $("sees").innerHTML = Object.entries(d.state)
    .filter(([key]) => key !== "goal")
    .map(([key, value]) => `<dt>${key.replaceAll("_", " ")}</dt><dd>${value}</dd>`)
    .join("");
}

const PUSH_COLOR = Object.fromEntries(LEVELS.map((level, i) => [
  level, ["#6b7b8f", "#8796a8", "#5dade2", "#19c3b0", "#2ecc71", "#c5d93a", "#f1c40f", "#e67e22", "#e8412c"][i],
]));

function noteText(h) {
  if (!h) return "–";
  if (h.off) return `<span class="bad">off track</span>`;
  if (h.slid) return `<span class="warn">${h.time.toFixed(2)} s · slid</span>`;
  return `${h.time.toFixed(2)} s`;
}

function renderEngineer() {
  const rows = TRACK.corners.map(c => {
    const history = engineer.history[c.name] || [], plan = levelOf(c);
    const trail = history
      .map(h => `<i class="${h.off ? "off" : h.slid ? "slid" : ""}" style="background:${PUSH_COLOR[h.push]}"
        title="lap ${h.lap}: ${h.push}${h.off ? ", off track" : h.slid ? ", slid" : ""}"></i>`)
      .join("");
    const arrow = { faster: "▲", slower: "▼", same: "=" }[engineer.steps?.[c.name]] || "";
    return `<tr><th>${c.short}</th><td class="dots">${trail}</td><td>${noteText(history.at(-1))}</td>
      <td style="color:${PUSH_COLOR[plan]}">${arrow} ${plan}</td></tr>`;
  });
  const legend = LEVELS.map(l => `<span><i style="background:${PUSH_COLOR[l]}"></i>${l}</span>`).join("");
  $("engineer").innerHTML = `<table><tr><th></th><th>history</th><th>last lap</th><th>next lap</th></tr>${rows.join("")}</table>
    <p class="legend">${legend}<span><i class="slid"></i>slid</span><span><i class="off"></i>off</span></p>`;
}

function fmt(seconds) {
  if (seconds == null) return "–";
  const m = Math.floor(seconds / 60), s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function renderPanel() {
  const row = car => {
    const current = car.finished ? "finished" : game.state === "idle" ? "–" : fmt(game.t - car.lapStart);
    const best = car.laps.length ? fmt(Math.min(...car.laps)) : "–";
    const lap = Math.min(car.lap, game.lapsTotal);
    return `<tr><th style="color:${car.color}">${car.name}</th><td>${lap}/${game.lapsTotal}</td><td>${current}</td>
      <td>${best}</td><td>${(car.v * 3.6).toFixed(0)}</td><td>${car.offCount}</td></tr>`;
  };
  const lapList = jev.laps.map((t, i) => `<span${t === Math.min(...jev.laps) ? ' class="best"' : ""}>L${i + 1} ${fmt(t)}</span>`);
  $("timing").innerHTML = `<table><tr><th></th><th>lap</th><th>current</th><th>best</th><th>km/h</th><th>off</th></tr>
    ${row(jev)}${game.playerActive ? row(you) : ""}</table><p class="laplist">${lapList.join("") || "Jev's lap times appear here"}</p>`;
  const perSecond = game.recent.length > 1 ? (game.recent.length - 1) / ((game.recent.at(-1) - game.recent[0]) / 1000) : 0;
  const stats = {
    decisions: game.decisions,
    "latency (avg)": game.latencyAvg == null ? "–" : `${game.latencyAvg.toFixed(0)} ms`,
    "decisions / s": perSecond.toFixed(1),
    "tokens": game.tokens.toLocaleString(),
    "cost so far": `$${game.cost.toFixed(4)}`,
    "crashes": jev.crashes,
    "model": game.model || "–",
  };
  $("stats").innerHTML = Object.entries(stats).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

// ---------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------

const canvas = $("view"), ctx = canvas.getContext("2d");

function fitCanvas() {
  const dpr = devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
}

function drawTrack() {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#e9e9e9"; // white edge lines
  ctx.lineWidth = CFG.halfWidth * 2 + 1.2;
  ctx.stroke(TRACK.path);
  for (const p of TRACK.cornerPaths) { // red and white kerbs through the corners
    ctx.strokeStyle = "#f4f4f4";
    ctx.lineWidth = CFG.halfWidth * 2 + 3;
    ctx.stroke(p);
    ctx.setLineDash([2.5, 2.5]);
    ctx.strokeStyle = "#d63a2f";
    ctx.stroke(p);
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = "#3b3e44";
  ctx.lineWidth = CFG.halfWidth * 2;
  ctx.stroke(TRACK.path);
  ctx.setLineDash([4, 6]);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 0.3;
  ctx.stroke(TRACK.path);
  ctx.setLineDash([]);

  // Chequered start line across the track at index 0.
  const th = TRACK.h[0], nx = -Math.sin(th), ny = Math.cos(th), tx = Math.cos(th), ty = Math.sin(th);
  const cells = 8, size = (CFG.halfWidth * 2) / cells;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cells; c++) {
      ctx.fillStyle = (r + c) % 2 ? "#111" : "#fafafa";
      const off = -CFG.halfWidth + c * size, along = r * size;
      ctx.beginPath();
      ctx.moveTo(TRACK.x[0] + nx * off + tx * along, TRACK.y[0] + ny * off + ty * along);
      ctx.lineTo(TRACK.x[0] + nx * (off + size) + tx * along, TRACK.y[0] + ny * (off + size) + ty * along);
      ctx.lineTo(TRACK.x[0] + nx * (off + size) + tx * (along + size), TRACK.y[0] + ny * (off + size) + ty * (along + size));
      ctx.lineTo(TRACK.x[0] + nx * off + tx * (along + size), TRACK.y[0] + ny * off + ty * (along + size));
      ctx.fill();
    }
  }
}

function drawTrail(car) {
  ctx.lineWidth = 0.9;
  for (let i = 1; i < car.trail.length; i++) {
    const a = car.trail[i - 1], b = car.trail[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) > 15) continue; // skip jumps after a reset
    ctx.globalAlpha = 0.25 + 0.6 * (i / car.trail.length);
    ctx.strokeStyle = PEDAL_COLOR[b.pedal] || "#888";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawCar(car) {
  const s = CFG.carScale;
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.h);
  ctx.scale(s, s);
  ctx.fillStyle = "#111"; // tyres
  for (const [x, y] of [[1.55, 0.95], [1.55, -0.95], [-1.45, 1.0], [-1.45, -1.0]]) ctx.fillRect(x - 0.45, y - 0.28, 0.9, 0.56);
  ctx.fillStyle = car.color;
  ctx.beginPath(); // body tapering to the nose
  ctx.moveTo(2.6, 0);
  ctx.lineTo(1.2, 0.42);
  ctx.lineTo(-0.2, 0.7);
  ctx.lineTo(-2.1, 0.55);
  ctx.lineTo(-2.1, -0.55);
  ctx.lineTo(-0.2, -0.7);
  ctx.lineTo(1.2, -0.42);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(2.35, -0.95, 0.35, 1.9); // front wing
  ctx.fillRect(-2.55, -0.85, 0.45, 1.7); // rear wing
  ctx.fillStyle = "#111";
  ctx.beginPath(); // cockpit
  ctx.ellipse(0.1, 0, 0.45, 0.25, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function toScreen(x, y, view) {
  return [view.cx + (x - view.fx) * view.s, view.cy - (y - view.fy) * view.s];
}

function drawLabels(view, dpr) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = "center";
  ctx.font = `600 ${11 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  for (const c of TRACK.corners) {
    const i = c.apex, side = -c.sign * (CFG.halfWidth + 12); // label on the outside of the bend
    const [sx, sy] = toScreen(TRACK.x[i] - Math.sin(TRACK.h[i]) * side, TRACK.y[i] + Math.cos(TRACK.h[i]) * side, view);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(c.short, sx, sy);
  }
  for (const car of [jev, ...(game.playerActive ? [you] : [])]) {
    const [sx, sy] = toScreen(car.x, car.y, view);
    ctx.fillStyle = car.color;
    ctx.fillText(car.name, sx, sy - 16 * dpr);
  }
}

function drawMinimap(dpr) {
  if (!drawMinimap.box) {
    const xs = TRACK.x, ys = TRACK.y;
    drawMinimap.box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  const b = drawMinimap.box, w = 190 * dpr, h = 130 * dpr, pad = 10 * dpr, left = 12 * dpr, top = 12 * dpr;
  const s = Math.min((w - 2 * pad) / (b.maxX - b.minX), (h - 2 * pad) / (b.maxY - b.minY));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(10,14,20,0.72)";
  ctx.fillRect(left, top, w, h);
  const ox = left + pad - b.minX * s + (w - 2 * pad - (b.maxX - b.minX) * s) / 2;
  const oy = top + pad + b.maxY * s + (h - 2 * pad - (b.maxY - b.minY) * s) / 2;
  ctx.setTransform(s, 0, 0, -s, ox, oy);
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2.2 / s;
  ctx.stroke(TRACK.path);
  for (const car of [jev, ...(game.playerActive ? [you] : [])]) {
    ctx.fillStyle = car.color;
    ctx.beginPath();
    ctx.arc(car.x, car.y, 4.5 / s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function draw() {
  fitCanvas();
  const dpr = devicePixelRatio || 1, W = canvas.width, H = canvas.height;
  const focus = game.follow === "you" && game.playerActive ? you : jev;
  const view = { s: CFG.zoom * dpr, cx: W / 2, cy: H / 2, fx: focus.x, fy: focus.y };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#1f3a22";
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(view.s, 0, 0, -view.s, view.cx - view.fx * view.s, view.cy + view.fy * view.s);
  drawTrack();
  drawTrail(jev);
  if (game.playerActive) drawCar(you);
  drawCar(jev);
  drawLabels(view, dpr);
  drawMinimap(dpr);
}

// ---------------------------------------------------------------------------------------
// Main loop: fixed physics steps, one draw per frame
// ---------------------------------------------------------------------------------------

let lastFrame = performance.now();
function frame(now) {
  const real = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (game.state === "racing") {
    let remaining = real * game.speed;
    while (remaining > 1e-6 && game.state === "racing") {
      const dt = Math.min(remaining, 1 / 120);
      step(dt);
      remaining -= dt;
    }
  }
  draw();
  renderPanel();
  requestAnimationFrame(frame);
}

setState("idle");
resetEngineer();
renderEngineer();
requestAnimationFrame(frame);
