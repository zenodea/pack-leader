// The dot field. Every dot is an agent; the orange one is the leader. Each section of the
// page names a formation (data-scene) and the leader pulls the dots into it.
// Without JavaScript the page is plain text with a normal heading.
document.documentElement.classList.add("js");
// The same engine runs on the landing page and on the docs, where the dots are the dividers.
const landing = !!document.querySelector(".hero");
const ROOT = new URL("./", document.currentScript.src);

const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

const C = {
  agent: [207, 222, 255],
  dim: [120, 138, 175],
  work: [124, 196, 255],
  violet: [178, 156, 255],
  teal: [94, 234, 212],
  pink: [244, 150, 190],
  done: [110, 231, 168],
  ask: [255, 200, 87],
  leader: [255, 150, 72],
};
const TINTS = [C.work, C.violet, C.teal, C.pink];

let W = 0, H = 0, DPR = 1, narrow = false;
let dots = [];
const leader = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, a: 0, ta: 0, s: 8, ts: 8, hot: 0, trail: [], rings: [], lastRing: 0, movedAt: 0, idle: 0 };
let lastScroll = 0, lastY = scrollY;
addEventListener("scroll", () => { lastScroll = performance.now(); }, { passive: true });
let form = null;          // the current formation
let scene = "scatter";
let wanted = "title";     // the section in view, applied once the intro is over
let sceneAt = 0;
let introDone = still;
const mouse = { x: -1e4, y: -1e4 };

function size() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  narrow = W <= 820;
}

const baseCount = () => (narrow ? 900 : 1300);
function newDot() {
  const x = Math.random() * W, y = Math.random() * H;
  return {
    x, y, vx: 0, vy: 0, tx: x, ty: y, hx: x, hy: y,
    c: C.agent.slice(), tc: C.agent, a: 0, ta: .75, s: 1.5, ts: 1.5,
    k: .025 + Math.random() * .035, ph: Math.random() * 6.283,
    free: true, jit: 0, pulse: false, delay: 0, anchor: false,
  };
}
function makeDots() { dots = Array.from({ length: baseCount() }, newDot); }

// Where formations are drawn: the right half on wide screens, the top half on phones.
function stage() {
  if (narrow) return { x: W * .07, y: 78, w: W * .86, h: H * .36 };
  const w = Math.min(W * .44, 640);
  return { x: W - w - Math.max(40, (W - 1200) / 2 + 20), y: H * .17, w, h: H * .66 };
}

// Keep at most n points, spread evenly through the list.
function fit(pts, n) {
  if (pts.length <= n) return pts;
  const out = [], step = pts.length / n;
  for (let i = 0; i < n; i++) out.push(pts[Math.floor(i * step)]);
  return out;
}

function disc(cx, cy, m, r, extra) {
  const out = [];
  for (let j = 0; j < m; j++) {
    const a = j * 2.39996, rr = r * Math.sqrt((j + .5) / m);
    out.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, ...extra });
  }
  return out;
}

function lineDots(x0, y0, x1, y1, gap, extra) {
  const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.floor(len / gap));
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n, ...extra });
  return out;
}

function rectDots(r, gap, extra) {
  return [
    ...lineDots(r.x, r.y, r.x + r.w, r.y, gap, extra),
    ...lineDots(r.x + r.w, r.y, r.x + r.w, r.y + r.h, gap, extra),
    ...lineDots(r.x + r.w, r.y + r.h, r.x, r.y + r.h, gap, extra),
    ...lineDots(r.x, r.y + r.h, r.x, r.y, gap, extra),
  ];
}

const FORMS = {
  // The name, spelled in agents, with the leader as the full stop.
  title() {
    const slot = document.querySelector(".wordmark-slot").getBoundingClientRect();
    const top = slot.top + scrollY;
    const lines = ["LODESTAR"];
    const font = (fs) => `800 ${fs}px "Inter Tight", sans-serif`;
    const off = document.createElement("canvas");
    off.width = Math.ceil(slot.width); off.height = Math.ceil(slot.height);
    const o = off.getContext("2d");
    o.font = font(100);
    const stop = .32; // room for the leader after the last letter, in font sizes
    const widest = Math.max(...lines.map((l, i) => o.measureText(l).width / 100 + (i === lines.length - 1 ? stop : 0)));
    const fs = Math.min(slot.width * .96 / widest, slot.height / (.92 * (lines.length - 1) + .74));
    o.font = font(fs);
    o.fillStyle = "#fff"; o.textAlign = "center"; o.textBaseline = "alphabetic";
    const startY = (slot.height - fs * (.92 * (lines.length - 1) + .74)) / 2;
    let lead = null;
    lines.forEach((l, i) => {
      const last = i === lines.length - 1;
      const cx = slot.width / 2 - (last ? stop * fs / 2 : 0);
      const base = startY + fs * .74 + i * fs * .92;
      o.fillText(l, cx, base);
      if (last) lead = { x: slot.left + cx + o.measureText(l).width / 2 + fs * .16, y: top + base - fs * .07 };
    });
    const img = o.getImageData(0, 0, off.width, off.height).data;
    const want = dots.length * .9;
    let gap = 3, pts = [];
    do {
      pts = [];
      for (let y = 0; y < off.height; y += gap)
        for (let x = 0; x < off.width; x += gap)
          if (img[(Math.floor(y) * off.width + Math.floor(x)) * 4 + 3] > 140) pts.push({ x: slot.left + x, y: top + y, c: C.agent, s: Math.min(1.9, Math.max(1.1, gap * .3)) });
      gap += .5;
    } while (pts.length > want && gap < 20);
    return { pts, doc: true, leader: { ...lead, s: Math.max(5, Math.min(13, fs * .075)) } };
  },

  // The leader on top, one cluster of crewmates per task.
  delegate() {
    const S = stage(), names = ["parser", "validator", "tests", "docs"];
    const r = Math.min(S.w / 10, 50), m = narrow ? 50 : 90;
    const lx = S.x + S.w / 2, ly = S.y + S.h * .12;
    const pts = [], lines = [], labels = [{ x: lx, y: ly - 34, text: "leader", color: C.leader }];
    names.forEach((name, i) => {
      const cx = S.x + S.w * (i + .5) / names.length, cy = S.y + S.h * .64;
      pts.push(...disc(cx, cy, m, r, { c: TINTS[i], s: 1.6 }));
      lines.push([lx, ly + 14, cx, cy - r - 10]);
      labels.push({ x: cx, y: cy + r + 28, text: name });
    });
    return { pts, lines, labels, leader: { x: lx, y: ly, s: 9 } };
  },

  // The multiplexer: the leader's pane and three crewmate panes, each with a little output.
  panes() {
    const S = stage(), g = 14, half = (S.w - g) / 2, hh = (S.h - 2 * g) / 3;
    const panes = [
      { x: S.x, y: S.y, w: half, h: S.h, name: "leader", c: C.agent },
      { x: S.x + half + g, y: S.y, w: half, h: hh, name: "parser", c: TINTS[0] },
      { x: S.x + half + g, y: S.y + hh + g, w: half, h: hh, name: "validator", c: TINTS[1] },
      { x: S.x + half + g, y: S.y + 2 * (hh + g), w: half, h: hh, name: "tests", c: TINTS[2] },
    ];
    const gap = narrow ? 9 : 10;
    const pts = [], labels = [];
    const rows = [.72, .48, .84, .3, .6, .76, .4, .66];
    panes.forEach((p, i) => {
      pts.push(...rectDots(p, gap, { c: C.dim, s: 1.1 }));
      labels.push({ x: p.x + 12, y: p.y + 22, text: p.name, align: "left", color: i ? p.c : C.leader });
      const lines = Math.max(1, Math.min(i ? 3 : 8, Math.floor((p.h - 46) / 16)));
      for (let k = 0; k < lines; k++) {
        const y = p.y + 42 + k * 16, x0 = p.x + 14, len = (p.w - 28) * rows[(k + i * 3) % rows.length];
        pts.push(...lineDots(x0, y, x0 + len, y, 7, { c: p.c, s: 1.3, delay: 300 + k * 90 }));
      }
    });
    const L = panes[0], ly = L.y + 42 + Math.min(8, Math.floor((L.h - 46) / 16)) * 16;
    return { pts: fit(pts, dots.length), labels, leader: { x: L.x + 20, y: ly, s: 6 } };
  },

  // Three crewmates: one done, one busy, one waiting on an answer. A question travels up.
  ask() {
    const S = stage(), r = Math.min(S.w / 8, 58), m = narrow ? 60 : 110;
    const lx = S.x + S.w / 2, ly = S.y + S.h * .12;
    const kinds = [
      { name: "parser", state: "done", c: C.done },
      { name: "validator", state: "working", c: C.work, jit: 2.2 },
      { name: "tests", state: "asking", c: C.ask, pulse: true, note: "reject or skip?" },
    ];
    const pts = [], lines = [], labels = [{ x: lx, y: ly - 34, text: "leader", color: C.leader }];
    const centres = kinds.map((k, i) => {
      const cx = S.x + S.w * (i + .5) / 3, cy = S.y + S.h * .66;
      pts.push(...disc(cx, cy, m, r, { c: k.c, s: 1.6, jit: k.jit || 0, pulse: !!k.pulse }));
      lines.push([lx, ly + 14, cx, cy - r - 10]);
      labels.push({ x: cx, y: cy + r + 26, text: k.name, color: k.c });
      labels.push({ x: cx, y: cy + r + 44, text: k.note || k.state, color: k.c, dim: true });
      return { x: cx, y: cy - r - 10 };
    });
    const from = centres[2], to = { x: lx, y: ly + 12 };
    return {
      pts, lines, labels, leader: { x: lx, y: ly, s: 9 },
      // The question goes up in amber; the answer comes back down in white.
      draw(t) {
        const cyc = (t / 2600) % 1;
        let p, col;
        if (cyc < .4) { p = cyc / .4; col = C.ask; }
        else if (cyc < .55) return;
        else { p = 1 - (cyc - .55) / .4; col = C.agent; if (p < 0) return; }
        const e = p * p * (3 - 2 * p);
        const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
        glow(x, y, 3.2, col, 1);
      },
    };
  },

  // The log: one row per event, written in order, the leader as the cursor.
  record() {
    const S = stage();
    const rows = [
      ["dispatch", "parser", .9, C.work], ["dispatch", "validator", .75, C.violet],
      ["heartbeat", "parser", .35, C.dim], ["ask", "tests", .6, C.ask],
      ["reply", "tests", .45, C.leader], ["note", "validator", .55, C.violet],
      ["done", "parser", .8, C.done], ["done", "validator", .7, C.done], ["release", "parser", .3, C.dim],
    ];
    const rh = S.h / rows.length, lab = narrow ? 118 : 150, x0 = S.x + lab, span = S.w - lab;
    const pts = [], labels = [];
    let end = null;
    rows.forEach(([kind, who, f, c], i) => {
      const y = S.y + rh * (i + .5), delay = 150 + i * 160;
      labels.push({ x: S.x, y: y + 4, text: `${kind} ${who}`, align: "left", dim: true, delay });
      pts.push({ x: x0, y, c, s: 2.6, delay });
      const row = lineDots(x0 + 12, y, x0 + 12 + span * f, y, 6, { c: C.dim, s: 1.2, delay });
      pts.push(...row);
      end = { x: x0 + 12 + span * f + 16, y };
    });
    return { pts: fit(pts, dots.length), labels, leader: { ...end, s: 6 } };
  },

  // Each crewmate's branch, merged back into main by the leader, which sits at main's tip.
  review() {
    const S = stage(), mainY = S.y + S.h * .84, x0 = S.x, x1 = S.x + S.w * .93;
    const pts = [...lineDots(x0, mainY, x1, mainY, 7, { c: C.dim, s: 1.3 })];
    const lines = [], labels = [];
    ["lodestar/parser", "lodestar/validator", "lodestar/tests"].forEach((name, i) => {
      const sx = x0 + S.w * (.06 + .1 * i), lane = S.y + S.h * (.12 + .22 * i), ex = x0 + S.w * .66;
      const c = TINTS[i];
      for (let k = 0; k <= 14; k++) { // the curve up from main
        const u = k / 14, x = sx + 46 * u, y = mainY + (lane - mainY) * (1 - (1 - u) * (1 - u));
        pts.push({ x, y, c, s: 1.4 });
      }
      pts.push(...lineDots(sx + 52, lane, ex, lane, 7, { c, s: 1.4 }));
      for (let k = 1; k <= 3; k++) pts.push(...disc(sx + 52 + (ex - sx - 52) * k / 3.4, lane, 9, 4, { c, s: 1.6 }));
      const mx = x0 + S.w * (.74 + .07 * i);
      pts.push(...disc(mx, mainY, 12, 5.5, { c, s: 1.7, delay: 500 + i * 250 }));
      lines.push([ex + 6, lane, mx, mainY - 10]);
      labels.push({ x: sx + 58, y: lane - 14, text: name, align: "left", color: c });
    });
    labels.push({ x: x0 + S.w * .81, y: mainY + 40, text: "merged by the leader" });
    labels.push({ x: x0, y: mainY + 40, text: "main", align: "left", dim: true });
    return { pts, lines, labels, leader: { x: x0 + S.w * .97, y: mainY, s: 7 } };
  },

  // You talk to the Navigator; the Navigator only reads the leader, which keeps working.
  navigator() {
    const S = stage(), cy = S.y + S.h * .44;
    const you = { x: S.x + S.w * .04, y: cy }, adv = { x: S.x + S.w * .32, y: cy };
    const lx = S.x + S.w * .66, ly = cy, R = Math.min(S.w * .22, S.h * .36);
    const inbox = { x: lx - 30, y: ly + 26 };
    const pts = [
      ...disc(you.x, you.y, 10, 5, { c: C.agent, s: 1.8 }),
      ...disc(adv.x, adv.y, 40, 15, { c: C.violet, s: 1.7 }),
    ];
    [-1.1, .05, 1.2].forEach((k, i) => {
      const a = k, cx = lx + Math.cos(a) * R, cyy = ly + Math.sin(a) * R;
      pts.push(...disc(cx, cyy, narrow ? 30 : 50, Math.min(30, R * .38), { c: TINTS[i], s: 1.5, jit: 1.8 }));
    });
    const labels = [
      { x: you.x, y: you.y + 30, text: "you" },
      { x: adv.x, y: adv.y + 38, text: "navigator", color: C.violet },
      { x: lx, y: ly - 32, text: "leader", color: C.leader },
      { x: (adv.x + lx) / 2, y: cy + 18, text: "reads", dim: true },
    ];
    const lines = [[you.x + 12, you.y, adv.x - 20, adv.y], [adv.x + 20, adv.y, lx - 16, ly]];
    const move = (a, b, p, col, size) => {
      const e = p * p * (3 - 2 * p);
      glow(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e, size, col, 1);
    };
    return {
      pts, lines, labels, leader: { x: lx, y: ly, s: 8 },
      // A question and its answer, then a note passed on that waits in the leader's inbox.
      draw(t) {
        const u = (t / 4200) % 1;
        if (u < .25) move(you, adv, u / .25, C.agent, 2.6);
        else if (u < .5) move(adv, you, (u - .27) / .23, C.violet, 2.6);
        else if (u < .75) move(adv, inbox, (u - .52) / .23, C.ask, 2.4);
        else glow(inbox.x, inbox.y, 2.4, C.ask, Math.max(0, 1 - (u - .75) / .25));
      },
    };
  },

  // The crew at rest: slow orbits around the leader.
  rest() {
    const S = stage(), cx = S.x + S.w / 2, cy = S.y + S.h / 2, R = Math.min(S.w, S.h) / 2;
    const rings = [[.28, .14], [.5, .22], [.74, .3], [.96, .34]];
    const pts = [];
    const n = Math.floor(dots.length * .8);
    rings.forEach(([rr, share], ri) => {
      const m = Math.floor(n * share);
      for (let k = 0; k < m; k++) pts.push({ orbit: [cx, cy, R * rr, k / m * 6.283, (ri % 2 ? -1 : 1) * (.00006 + .00003 * ri)], c: ri === 0 ? C.leader : C.agent, s: ri === 0 ? 1.3 : 1.2, x: cx, y: cy });
    });
    return { pts, leader: { x: cx, y: cy, s: 11 }, faint: narrow };
  },
};

function setScene(name, force) {
  if (!introDone) { wanted = name; return; }
  if (name === scene && !force) return;
  const again = name === "docs" && scene === "docs";
  scene = name;
  sceneAt = performance.now();
  form = FORMS[name]();
  const pts = form.pts;
  // Shuffle which dot goes where, so every change is a proper reshuffle.
  // A long docs page can need more dots than the landing has.
  while (dots.length < Math.min(pts.length, 4000)) dots.push(newDot());
  let order = dots.map((_, i) => i).sort(() => Math.random() - .5);
  let plan = pts, kept = null;
  if (again) {
    // Another docs page: a dot keeps its key if the new page has it (the bar, the page list and
    // the search box don't move at all; section dividers slide to the new ones). Dots on lines the
    // new page no longer has go to its new places, or fade out where they are.
    const byKey = new Map();
    for (const [i, d] of dots.entries()) if (!d.free && d.key) byKey.set(d.key, i);
    const taken = new Set(), fresh = [];
    plan = [];
    kept = new Set();
    order = [];
    for (const p of pts) {
      const i = byKey.get(p.key);
      if (i === undefined) { fresh.push(p); continue; }
      taken.add(i); kept.add(p); order.push(i); plan.push(p);
    }
    const spare = dots.map((_, i) => i).filter((i) => !taken.has(i)).sort((a, b) => dots[a].free - dots[b].free);
    for (const p of fresh) { order.push(spare.shift()); plan.push(p); }
    for (const i of spare) { order.push(i); Object.assign(dots[i], { hx: dots[i].x, hy: dots[i].y }); }
  }
  order.forEach((di, i) => {
    const d = dots[di], p = plan[i];
    if (p) {
      const stays = kept && kept.has(p);
      Object.assign(d, { free: false, tx: p.x, ty: p.y, tc: p.c, ts: p.s, ta: p.a ?? (form.faint ? .45 : .95), jit: p.jit || 0, pulse: !!p.pulse, delay: stays ? 0 : p.delay || 0, orbit: p.orbit || null, anchor: !!(form.doc || p.anchor), key: p.key || null });
      // A dot that only shows once something has loaded starts out there, unseen, and fades in.
      if (p.pop && !stays) Object.assign(d, { x: p.x, y: p.y, vx: 0, vy: 0, a: 0, c: p.c.slice() });
    } else {
      if (!again) Object.assign(d, { hx: Math.random() * W, hy: Math.random() * H });
      Object.assign(d, { free: true, key: null, tc: C.dim, ts: 1, ta: form.hideRest ? 0 : .16, jit: 0, pulse: false, delay: 0, orbit: null, anchor: false });
    }
    if (still) { d.x = d.tx; d.y = d.ty; }
  });
  leader.tx = form.leader.x; leader.ty = form.leader.y; leader.ts = form.leader.s; leader.ta = 1;
  if (still) { leader.x = leader.tx; leader.y = leader.ty - (form.doc ? scrollY : 0); }
}

// The leader calls the crew: a ring of light goes out, and the dots it passes flare.
const RING_LIFE = 1800;
function call(at) { leader.rings.push(at); leader.lastRing = at; }

function drawLeader(now) {
  const { x, y, a } = leader;
  const t = still ? 0 : now;
  const s = leader.s * (1 + .28 * leader.hot + (still ? 0 : .05 * leader.idle * Math.sin(t * .0031)));
  const radial = (r, stops) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  };

  // A fading trail while it travels.
  leader.trail.forEach((p, i) => {
    const k = i / leader.trail.length;
    ctx.fillStyle = `rgba(255,140,60,${.22 * k * k * a})`;
    ctx.beginPath(); ctx.arc(p[0], p[1], s * (.4 + .9 * k), 0, 6.283); ctx.fill();
  });

  // Rings going out.
  ctx.lineWidth = 1.2;
  for (const born of leader.rings) {
    const u = (now - born) / RING_LIFE;
    if (u < 0 || u > 1) continue;
    const e = 1 - (1 - u) * (1 - u) * (1 - u);
    ctx.strokeStyle = `rgba(255,170,105,${.45 * (1 - u) * a})`;
    ctx.beginPath(); ctx.arc(x, y, s * 2 + e * ringReach(), 0, 6.283); ctx.stroke();
  }

  // Bloom.
  ctx.fillStyle = radial(s * 18, [[0, `rgba(255,120,40,${.2 * a})`], [.35, `rgba(255,100,30,${.06 * a})`], [1, "rgba(255,90,20,0)"]]);
  ctx.beginPath(); ctx.arc(x, y, s * 18, 0, 6.283); ctx.fill();

  // A soft horizontal lens streak.
  ctx.save();
  ctx.translate(x, y); ctx.scale(1, .07);
  const streak = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 7);
  streak.addColorStop(0, `rgba(255,200,150,${.42 * a})`);
  streak.addColorStop(1, "rgba(255,160,90,0)");
  ctx.fillStyle = streak; ctx.beginPath(); ctx.arc(0, 0, s * 7, 0, 6.283); ctx.fill();
  ctx.restore();

  // Two slow-turning spikes.
  for (let i = 0; i < 2; i++) {
    const ang = t * .00012 * (i ? -1 : 1) + i * 1.1, len = s * (3.6 + .6 * leader.idle * Math.sin(t * .0017 + i));
    const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
    const g = ctx.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
    g.addColorStop(0, "rgba(255,170,100,0)"); g.addColorStop(.5, `rgba(255,190,130,${.32 * a})`); g.addColorStop(1, "rgba(255,170,100,0)");
    ctx.strokeStyle = g; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
  }

  // The corona: a wobbling edge, so it never sits still like a picture.
  for (let layer = 0; layer < 2; layer++) {
    const base = s * (layer ? 3.1 : 2.2), sp = layer ? -.0011 : .0016;
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const ang = i / 48 * 6.283;
      const r = base * (1 + .1 * Math.sin(ang * 5 + t * sp) + .07 * Math.sin(ang * 8 - t * sp * 1.7) + .05 * Math.sin(ang * 3 + t * .0007));
      i ? ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r) : ctx.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    }
    ctx.fillStyle = radial(base * 1.2, layer
      ? [[0, `rgba(255,120,45,${.32 * a})`], [1, "rgba(255,90,30,0)"]]
      : [[0, `rgba(255,170,90,${.75 * a})`], [.55, `rgba(255,120,45,${.35 * a})`], [1, "rgba(255,100,40,0)"]]);
    ctx.fill();
  }

  // The hot core.
  ctx.fillStyle = radial(s * 1.15, [[0, `rgba(255,255,248,${a})`], [.45, `rgba(255,226,180,${a})`], [.8, `rgba(255,170,95,${a})`], [1, `rgba(255,140,60,${.0})`]]);
  ctx.beginPath(); ctx.arc(x, y, s * 1.15, 0, 6.283); ctx.fill();
}
function ringReach() { return narrow ? 260 : 420; }

function glow(x, y, s, c, a) {
  ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a * .14})`;
  ctx.beginPath(); ctx.arc(x, y, s * 3.2, 0, 6.283); ctx.fill();
  ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  ctx.beginPath(); ctx.arc(x, y, s, 0, 6.283); ctx.fill();
}

function frame(now) {
  if (paused) { requestAnimationFrame(frame); return; }
  const off = form && form.doc ? scrollY : 0;
  // Dots pinned to the page move with it exactly, so scrolling never makes them drift.
  const dy = scrollY - lastY;
  lastY = scrollY;
  const hide = scene === "docs" ? occluders() : [];
  // In the contents list, the dots next to the section you're reading glow blue: that's the marker.
  const reading = scene === "docs" ? document.querySelector(".toc a.on")?.getBoundingClientRect() : null;
  const since = now - sceneAt;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // The leader's warm light (not over the docs' text).
  if (leader.a > .01 && scene !== "docs") {
    const g = ctx.createRadialGradient(leader.x, leader.y, 0, leader.x, leader.y, 340);
    g.addColorStop(0, `rgba(255,140,60,${.16 * leader.a})`);
    g.addColorStop(1, "rgba(255,140,60,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  const fade = still ? 1 : Math.min(1, Math.max(0, (since - 450) / 500));
  if (form && form.lines && fade > 0) {
    ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(255,170,110,${.32 * fade})`;
    for (const [a, b, c, d] of form.lines) { ctx.beginPath(); ctx.moveTo(a, b - off); ctx.lineTo(c, d - off); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  // Rings in flight, as radii, so dots can flare as one passes.
  const live = [];
  if (!still) {
    leader.rings = leader.rings.filter((b) => now - b < RING_LIFE);
    for (const born of leader.rings) {
      const u = (now - born) / RING_LIFE;
      live.push([leader.s * 2 + (1 - (1 - u) ** 3) * ringReach(), 1 - u]);
    }
    // Only once the page and the leader have been still for a moment.
    const quietFor = now - Math.max(lastScroll, sceneAt, leader.movedAt);
    if (introDone && scene !== "docs" && quietFor > 2200 && now - leader.lastRing > (leader.hot > .5 ? 1400 : 4800)) call(now);
  }

  ctx.globalCompositeOperation = "lighter";
  for (const d of dots) {
    if (d.anchor) d.y -= dy;
    if (scene === "docs" && d.key && d.key.startsWith("toc:")) {
      const lit = reading && d.ty >= reading.top && d.ty <= reading.bottom;
      d.tc = lit ? C.work : DOT_LINE; d.ta = lit ? .95 : .4; d.ts = lit ? 1.15 : 1;
    }
    let tx = d.tx, ty = d.ty - (d.anchor ? scrollY : 0);
    if (d.free) {
      tx = d.hx + Math.sin(now * .00023 + d.ph) * 60;
      ty = d.hy + Math.cos(now * .00019 + d.ph * 1.3) * 60;
    } else if (d.orbit) {
      const [cx, cy, r, a0, sp] = d.orbit, a = a0 + now * sp * (still ? 0 : 1);
      tx = cx + Math.cos(a) * r; ty = cy + Math.sin(a) * r * .62;
    }
    if (d.jit && !still) { tx += Math.sin(now * .011 + d.ph * 9) * d.jit; ty += Math.cos(now * .013 + d.ph * 7) * d.jit; }
    const shown = since >= d.delay;
    if (!still) {
      const k = d.free ? .01 : d.k;
      d.vx = (d.vx + (tx - d.x) * k) * .84;
      d.vy = (d.vy + (ty - d.y) * k) * .84;
      const mx = d.x - mouse.x, my = d.y - mouse.y, md = mx * mx + my * my;
      if (md < 8100 && md > .1 && scene !== "docs") { const f = (90 - Math.sqrt(md)) / 90 * 1.6 / Math.sqrt(md); d.vx += mx * f; d.vy += my * f; }
      d.x += d.vx; d.y += d.vy;
    } else { d.x = tx; d.y = ty; }
    for (let i = 0; i < 3; i++) d.c[i] += (d.tc[i] - d.c[i]) * .06;
    d.a += ((shown ? d.ta : 0) - d.a) * .08;
    d.s += (d.ts - d.s) * .08;
    let a = d.a;
    if (d.pulse && !still) a *= .55 + .45 * Math.sin(now * .005 + d.ph * .3);
    if (a < .01) continue;
    // Warm light from the leader on the dots close to it, and a flare where a ring passes.
    let col = d.c, size = d.s;
    if (leader.a > .01) {
      const dist = Math.hypot(d.x - leader.x, d.y - leader.y);
      let warm = Math.max(0, 1 - dist / (leader.s * 22)) ** 2 * .7 * leader.a;
      for (const [r, left] of live) {
        const band = Math.abs(dist - r);
        if (band < 16) { const f = (1 - band / 16) * left; warm = Math.max(warm, f); a = Math.min(1, a + f * .8); size += f * 1.1; }
      }
      if (warm > .01) col = [d.c[0] + (255 - d.c[0]) * warm, d.c[1] + (178 - d.c[1]) * warm, d.c[2] + (110 - d.c[2]) * warm];
    }
    if (d.y < -6 || d.y > H + 6 || (hide.length && hide.some((r) => d.x > r.left && d.x < r.right && d.y > r.top && d.y < r.bottom))) continue;
    if (size > 2) glow(d.x, d.y, size, col, a);
    else {
      ctx.fillStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${a})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, size, 0, 6.283); ctx.fill();
    }
  }

  if (form && form.draw && fade > 0 && !still) form.draw(now);

  // The leader.
  if (!still) {
    leader.vx = (leader.vx + (leader.tx - leader.x) * .035) * .82;
    if (form && form.doc) leader.y -= dy;
    leader.vy = (leader.vy + (leader.ty - off - leader.y) * .035) * .82;
    leader.x += leader.vx; leader.y += leader.vy;
  } else { leader.x = leader.tx; leader.y = leader.ty - off; }
  leader.a += (leader.ta - leader.a) * .05;
  leader.s += (leader.ts - leader.s) * .06;
  // It notices the pointer: brighter, and it calls more often.
  const near = Math.hypot(mouse.x - leader.x, mouse.y - leader.y) < 140 ? 1 : 0;
  leader.hot += (near - leader.hot) * .06;
  if (Math.hypot(leader.vx, leader.vy) > .3) leader.movedAt = now;
  const settled = now - Math.max(lastScroll, leader.movedAt) > 1500 ? 1 : 0;
  leader.idle += (settled - leader.idle) * .03;
  if (!still) {
    if (Math.hypot(leader.vx, leader.vy) > .6) leader.trail.push([leader.x, leader.y]);
    else leader.trail.shift();
    if (leader.trail.length > 16) leader.trail.shift();
  }
  if (leader.a > .01) drawLeader(now);
  ctx.globalCompositeOperation = "source-over";

  if (form && form.labels && fade > 0) {
    ctx.font = `500 ${narrow ? 11 : 12.5}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    for (const l of form.labels) {
      const la = Math.min(fade, still ? 1 : Math.max(0, (since - (l.delay || 0) - 200) / 300));
      const c = l.color || [200, 210, 230];
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${la * (l.dim ? .55 : .85)})`;
      ctx.textAlign = l.align || "center";
      ctx.fillText(l.text, l.x, l.y - off);
    }
  }
  requestAnimationFrame(frame);
}

// Which section is in the middle of the screen decides the formation.
const watcher = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) setScene(e.target.dataset.scene);
}, { rootMargin: "-50% 0px -50% 0px" });
document.querySelectorAll("[data-scene]").forEach((s) => watcher.observe(s));

addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
addEventListener("pointerleave", () => { mouse.x = mouse.y = -1e4; });
document.addEventListener("mouseleave", () => { mouse.x = mouse.y = -1e4; });

let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const was = narrow;
    size();
    if (was !== narrow) makeDots();
    if (inDocs) onDocsShown();
    else if (introDone) setScene(scene, true);
  }, 150);
});

size();
makeDots();
leader.x = leader.tx = W / 2; leader.y = leader.ty = H * .62;
sceneAt = performance.now();
requestAnimationFrame(frame);

// The intro: agents drift about with nobody in charge, then the leader turns up.
document.fonts.load('800 100px "Inter Tight"').catch(() => {}).finally(() => {
  setTimeout(() => {
    introDone = true;
    if (landing) setScene(wanted, true);
    else if (docsForm) setScene("docs", true);
  }, still ? 0 : landing ? 1500 : 250);
});

// Into the docs without a reload: the landing fades, the dots fly onto the docs' lines
// (the top bar, the page list's edge, the contents' edge, the search box, the section
// dividers) and the leader onto the logo dot. Then the real page fades in on top of them.
const HOME = ROOT;
const DOCS = new URL("docs/", HOME);
let docsForm = null, inDocs = !landing && !!document.getElementById("doc"), busy = false, paused = false, savedY = 0, shell = null;
FORMS.docs = () => docsForm;
const isDocs = (u) => new URL(u, location.href).pathname.startsWith(DOCS.pathname);
const wait = (ms) => new Promise((r) => setTimeout(r, still ? 0 : ms));
const loadShell = () => (shell ||= fetch(DOCS).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }));
// The renderer and the docs' script: neither does anything on the landing until mounted.
let scripts = null;
const loadScripts = () => (scripts ||= load("script", "marked-js", { src: "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js" })
  .then(() => window.packDocs || load("script", "docs-js", { src: new URL("docs.js?v=6", DOCS).href })));
const REVEAL = 450;

function load(tag, id, attrs) {
  const old = document.getElementById(id);
  if (old) return old.ready;
  const el = Object.assign(document.createElement(tag), attrs);
  el.id = id;
  el.ready = new Promise((ok, fail) => { el.onload = ok; el.onerror = fail; });
  (tag === "link" ? document.head : document.body).appendChild(el);
  return el.ready;
}

// Where the docs' dots are: the same 6px grid docs.css draws its dividers on.
const DOT_LINE = [168, 178, 204];
function docsLines(root, selDelay = 0) {
  const pts = [], dot = { c: DOT_LINE, s: 1, a: .4 };
  // Every dot has a key (which line, which place on it), so a page change only moves what changed.
  const row = (key, x0, x1, y) => { for (let x = x0 + 3, i = 0; x < x1; x += 6, i++) pts.push({ x, y, key: `${key}:${i}`, ...dot }); };
  const col = (key, x, y0, y1) => { for (let y = y0 + 3, i = 0; y < y1; y += 6, i++) pts.push({ x, y, key: `${key}:${i}`, ...dot }); };
  const box = (el) => el ? el.getBoundingClientRect() : { width: 0, height: 0 };
  const bar = box(root.querySelector(".bar"));
  row("bar", bar.left, bar.right, bar.bottom - 1.5);
  const side = box(root.querySelector(".side"));
  if (side.left >= -1 && side.width) col("side", side.right - 1.5, side.top, Math.min(side.bottom, H));
  // The page you're on: a ball of crewmates under its name in the page list. It appears once the
  // page has loaded: keyed by page, so a new page's ball fades in while the old one fades out.
  const cur = root.querySelector('.side a[aria-current="page"]');
  const page = cur && cur.getAttribute("href");
  if (cur && side.left >= -1 && side.width) {
    const r = cur.getBoundingClientRect(), n = 120;
    for (let j = 0; j < n; j++) {
      const ang = j * 2.39996, rr = Math.sqrt((j + .5) / n);
      pts.push({ x: r.left + r.width / 2 + Math.cos(ang) * rr * r.width * .5, y: r.top + r.height / 2 + Math.sin(ang) * rr * r.height * .55,
        key: `sel:${page}:${j}`, c: C.work, s: 1.1, a: .55, jit: .5, pop: true, delay: selDelay });
    }
  }
  const toc = box(root.querySelector(".toc ul"));
  if (toc.height) col("toc", toc.left + 1.5, toc.top, Math.min(toc.bottom, H));
  const q = box(root.querySelector(".search input"));
  if (q.width) { row("qt", q.left, q.right, q.top + 1.5); row("qb", q.left, q.right, q.bottom - 1.5); col("ql", q.left + 1.5, q.top, q.bottom); col("qr", q.right - 1.5, q.top, q.bottom); }
  // Section dividers belong to the page: pinned to it, in page coordinates.
  const pinned = pts.length;
  [...root.querySelectorAll(".doc h2, .doc hr")].forEach((el, k) => {
    const r = el.getBoundingClientRect();
    row(`sec${k}`, r.left, r.right, r.top + scrollY + 1.5);
  });
  for (let i = pinned; i < pts.length; i++) pts[i].anchor = true;
  const logo = box(root.querySelector(".logo-dot"));
  return { pts: pts.slice(0, 4000), hideRest: true, leader: { x: logo.left + logo.width / 2, y: logo.top + logo.height / 2, s: 4.5 } };
}

async function goDocs(url, push = true) {
  if (busy || inDocs) return;
  busy = true;
  let html;
  try { html = await loadShell(); } catch { location.href = url; return; }
  const ready = loadScripts();
  ready.catch(() => {});
  savedY = scrollY;
  introDone = true;
  document.body.classList.add("to-docs");
  await Promise.all([load("link", "docs-css", { rel: "stylesheet", href: new URL("docs.css?v=8", DOCS).href }), wait(320)]);
  const root = document.createElement("div");
  root.id = "docs-root"; root.className = "ghost";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const el of [...parsed.body.children]) if (!/^(SCRIPT|NOSCRIPT|CANVAS)$/.test(el.tagName)) root.appendChild(document.adoptNode(el));
  document.body.classList.add("in-docs");
  document.body.appendChild(root);
  if (push) history.pushState({ docs: true }, "", url);
  inDocs = true;
  const shown = new Promise((r) => document.addEventListener("docs:shown", r, { once: true }));
  try { await ready; window.packDocs.mount(); } catch { location.reload(); return; }
  await Promise.race([shown, wait(2500)]);
  docsForm = docsLines(root, still ? 0 : REVEAL);
  setScene("docs", true);
  await wait(REVEAL);
  root.classList.remove("ghost");
  busy = false;
}

// A new docs page (or a resize): the dots move to its dividers.
function onDocsShown() {
  if (!inDocs || busy) return;
  docsForm = docsLines(document.getElementById("docs-root") || document);
  if (introDone) setScene("docs", true);
}
document.addEventListener("docs:shown", onDocsShown);
let sideFrame = 0;
document.addEventListener("scroll", (e) => {
  if (e.target.id !== "side" || sideFrame) return;
  sideFrame = requestAnimationFrame(() => { sideFrame = 0; onDocsShown(); });
}, true);
if (window.packDocsShown) onDocsShown();

// Things drawn over the docs that the dots shouldn't show through.
function occluders() {
  const out = [], res = document.getElementById("results"), side = document.getElementById("side");
  if (res && !res.hidden) out.push(res.getBoundingClientRect());
  if (side && side.classList.contains("open")) out.push(side.getBoundingClientRect());
  return out;
}

function sectionInView() {
  for (const el of document.querySelectorAll("[data-scene]")) {
    const r = el.getBoundingClientRect();
    if (r.top <= H / 2 && r.bottom >= H / 2) return el.dataset.scene;
  }
  return "title";
}

// Back out of the docs: the lines turn back into dots, which go back to whatever section you left.
async function goHome(push = true) {
  if (busy || !inDocs) return;
  busy = true;
  const root = document.getElementById("docs-root");
  docsForm = docsLines(root);
  setScene("docs", true);
  for (const d of dots) { d.x = d.tx; d.y = d.ty; d.vx = d.vy = 0; d.s = d.ts; d.c = d.tc.slice(); d.a = d.free ? 0 : d.ta; }
  Object.assign(leader, { x: leader.tx, y: leader.ty, vx: 0, vy: 0, s: leader.ts, a: 1 });
  root.classList.add("ghost");
  await wait(450);
  if (push) history.pushState(null, "", HOME);
  root.remove();
  document.getElementById("docs-css")?.remove();
  document.title = "Lodestar";
  document.body.classList.remove("in-docs");
  window.scrollTo({ top: savedY, behavior: "instant" });
  inDocs = false;
  dots.length = Math.min(dots.length, baseCount());
  setScene(sectionInView(), true);
  await wait(40);
  document.body.classList.remove("to-docs");
  busy = false;
}

// Capture, so this runs before the docs' own link handling.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
  const url = new URL(a.href);
  if (url.origin !== location.origin) return;
  if (!landing) return; // on the docs page alone, the landing is a normal page load
  if (!inDocs && isDocs(url)) { e.preventDefault(); goDocs(url.href); }
  else if (inDocs && url.pathname === HOME.pathname && !url.search) { e.preventDefault(); goHome(); }
}, true);
addEventListener("popstate", () => {
  const there = isDocs(location.href);
  if (there && !inDocs) goDocs(location.href, false);
  else if (!there && inDocs) goHome(false);
});
// Fetch the docs early, so the transition doesn't wait on the network.
const prefetch = () => { loadShell().catch(() => {}); if (landing) loadScripts().then(() => window.packDocs.prefetch("introduction")).catch(() => {}); };
document.addEventListener("pointerover", (e) => { if (e.target.closest?.('a[href^="docs/"]')) prefetch(); }, { passive: true });
setTimeout(prefetch, 4000);

// Copy buttons.
const status = document.querySelector(".copy-status");
for (const button of document.querySelectorAll("[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source || !status) return;
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      status.textContent = button.dataset.copy === "install-herdr" ? "Copied. Run it inside herdr." : "Copied. Paste it into your agent.";
    } catch {
      // Clipboard may be unavailable on HTTP, file URLs or restricted browsers.
      const range = document.createRange();
      range.selectNodeContents(source);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      status.textContent = "Selected. Copy it with Ctrl+C or ⌘C.";
    }
  });
}
