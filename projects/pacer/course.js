// Course view: map, race-clock slider and elevation profile.
// Uses COURSE from course-data.js and STRATEGIES, computeSegments, elapsedAt,
// formatTime, svgEl and slider from app.js.

const SERIES_COLORS = ["#38bdf8", "#fb923c", "#f472b6", "#facc15"];
const SERIES_SHAPES = ["circle", "square", "diamond", "triangle"];
const MAX_COMPARE = SERIES_COLORS.length;
const FT_PER_M = 3.28084;
const RACE_START_SECONDS = 7 * 3600; // 7:00 a.m.
const PLAYBACK_SECONDS = 45; // real seconds to replay the whole race

const compareChips = document.getElementById("compareChips");
const timeSlider = document.getElementById("timeSlider");
const raceClock = document.getElementById("raceClock");
const timeOfDay = document.getElementById("timeOfDay");
const playButton = document.getElementById("playButton");
const courseMap = document.getElementById("courseMap");
const mapSvg = document.getElementById("mapSvg");
const mapTip = document.getElementById("mapTip");
const elevChart = document.getElementById("elevChart");
const elevSvg = document.getElementById("elevSvg");
const elevTip = document.getElementById("elevTip");
const runnerBody = document.getElementById("runnerBody");
const checkpointHead = document.getElementById("checkpointHead");
const checkpointBody = document.getElementById("checkpointBody");

// The strategy picked in the Split strategy panel (currentStrategy) is always compared, in slot 0.
// Extra strategies map key -> colour/shape slot (1-3) and keep their slot while selected.
const extras = new Map([["surgeSettle", 1]]);
const LOCK_ICON =
  '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
let raceTime = null;
let runners = []; // [{ key, slot, label, segments }]
let mapLayer = null; // { dynamic, cursor, xy }
let elevLayer = null; // { dynamic, cursor, x, y }
let playing = false;
let lastFrame = 0;

// Landmarks plus halfway, numbered in course order (S = start, F = finish)
const COURSE_CHECKPOINTS = (() => {
  const list = [...COURSE.landmarks, { name: "Halfway", d: MARATHON_MILES / 2 }].sort((a, b) => a.d - b.d);
  let n = 0;
  return list.map((cp) => ({
    ...cp,
    badge: cp.d === 0 ? "S" : cp.d >= MARATHON_MILES - 0.01 ? "F" : String(++n),
  }));
})();

// Course bounds for the map projection (equirectangular, fine at city scale)
const MAP_BOUNDS = (() => {
  const lats = COURSE.points.map((p) => p[0]);
  const lons = COURSE.points.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  return { minLat, maxLat, minLon, maxLon, kx, w: (maxLon - minLon) * kx, h: maxLat - minLat };
})();

// ---------- course lookups ----------

function courseAt(d) {
  const { points, distances, step } = COURSE;
  const i = Math.max(0, Math.min(Math.floor(d / step), distances.length - 2));
  const t = Math.min(Math.max((d - distances[i]) / (distances[i + 1] - distances[i]), 0), 1);
  const a = points[i];
  const b = points[i + 1];
  return {
    lat: a[0] + t * (b[0] - a[0]),
    lon: a[1] + t * (b[1] - a[1]),
    ft: (a[2] + t * (b[2] - a[2])) * FT_PER_M,
  };
}

// Percent grade over the surrounding 0.1 mile
function gradeAt(d) {
  const lo = Math.max(0, d - 0.05);
  const hi = Math.min(MARATHON_MILES, d + 0.05);
  return ((courseAt(hi).ft - courseAt(lo).ft) / ((hi - lo) * 5280)) * 100;
}

function distanceAtTime(segments, t) {
  if (t <= 0) return 0;
  const s = segments.find((seg) => t <= seg.elapsed);
  if (!s) return MARATHON_MILES;
  return s.start + (t - (s.elapsed - s.split)) / s.pace;
}

function finishTime() {
  return Number(slider.value) * MARATHON_MILES;
}

function formatTimeOfDay(raceSeconds) {
  const total = Math.floor(RACE_START_SECONDS + raceSeconds);
  const h24 = Math.floor(total / 3600) % 24;
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h24 % 12 || 12}:${m}:${s} ${h24 < 12 ? "a.m." : "p.m."}`;
}

function formatGrade(g) {
  const rounded = Math.round(g * 10) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1)}%`;
}

// ---------- marks ----------

function drawShape(parent, slot, x, y, r) {
  const attrs = { fill: SERIES_COLORS[slot], stroke: "#1e293b", "stroke-width": 2 };
  switch (SERIES_SHAPES[slot]) {
    case "square":
      return svgEl("rect", { ...attrs, x: x - r * 0.85, y: y - r * 0.85, width: r * 1.7, height: r * 1.7, rx: 1.5 }, parent);
    case "diamond":
      return svgEl("polygon", { ...attrs, points: `${x},${y - r * 1.2} ${x + r * 1.2},${y} ${x},${y + r * 1.2} ${x - r * 1.2},${y}` }, parent);
    case "triangle":
      return svgEl("polygon", { ...attrs, points: `${x},${y - r * 1.25} ${x + r * 1.15},${y + r * 0.85} ${x - r * 1.15},${y + r * 0.85}` }, parent);
    default:
      return svgEl("circle", { ...attrs, cx: x, cy: y, r }, parent);
  }
}

function swatchHtml(slot) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "swatch");
  svg.setAttribute("viewBox", "-8 -8 16 16");
  svg.setAttribute("aria-hidden", "true");
  drawShape(svg, slot, 0, 0, 5.5);
  return svg.outerHTML;
}

function drawBadge(parent, x, y, text) {
  const g = svgEl("g", { class: "badge-mark" }, parent);
  if (text.length > 1) {
    svgEl("rect", { x: x - 11, y: y - 9, width: 22, height: 18, rx: 9, fill: "#e2e8f0", stroke: "#1e293b", "stroke-width": 2 }, g);
  } else {
    svgEl("circle", { cx: x, cy: y, r: 9, fill: "#e2e8f0", stroke: "#1e293b", "stroke-width": 2 }, g);
  }
  const label = svgEl("text", { x, y: y + 0.5, class: "badge-text", "text-anchor": "middle", "dominant-baseline": "central" }, g);
  label.textContent = text;
  return g;
}

function showTooltip(tip, container, x, y, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(x, half), container.clientWidth - half)}px`;
  const above = y - tip.offsetHeight - 14;
  tip.style.top = `${above >= 0 ? above : y + 14}px`;
}

// ---------- map ----------

function renderMap() {
  const width = courseMap.clientWidth;
  const height = courseMap.clientHeight;
  if (!width || !height) return;
  mapSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  mapSvg.replaceChildren();

  const pad = 22;
  const b = MAP_BOUNDS;
  const scale = Math.min((width - 2 * pad) / b.w, (height - 2 * pad) / b.h);
  const ox = (width - b.w * scale) / 2;
  const oy = (height - b.h * scale) / 2;
  const project = (lat, lon) => [ox + (lon - b.minLon) * b.kx * scale, oy + (b.maxLat - lat) * scale];
  const toPath = (pts) => pts.map(([lat, lon], i) => `${i ? "L" : "M"}${project(lat, lon).map((v) => v.toFixed(1)).join(",")}`).join("");

  const defs = svgEl("defs", {}, mapSvg);
  const clip = svgEl("clipPath", { id: "mapClip" }, defs);
  svgEl("rect", { x: 0, y: 0, width, height }, clip);

  // River
  const river = svgEl("g", { "clip-path": "url(#mapClip)" }, mapSvg);
  COURSE.river.forEach((way) => {
    svgEl("path", { d: toPath(way), fill: "none", stroke: "#2c4a6b", "stroke-width": 7, "stroke-linecap": "round", "stroke-linejoin": "round" }, river);
  });

  // Route
  svgEl("path", {
    d: toPath(COURSE.points), fill: "none", stroke: "#64748b", "stroke-width": 3.5,
    "stroke-linecap": "round", "stroke-linejoin": "round",
  }, mapSvg);

  // Aid stations
  COURSE.aid.forEach((a) => {
    const [x, y] = project(a.lat, a.lon);
    const g = svgEl("g", {}, mapSvg);
    svgEl("path", { d: `M${x - 4},${y}h8M${x},${y - 4}v8`, stroke: "#94a3b8", "stroke-width": 2, "stroke-linecap": "round" }, g);
    svgEl("title", {}, g).textContent = `Aid station: ${a.items.join(", ")}`;
  });

  // Mile markers, labelling every fifth
  for (let mile = 1; mile <= 26; mile++) {
    const p = courseAt(mile);
    const [x, y] = project(p.lat, p.lon);
    svgEl("circle", { cx: x, cy: y, r: 2.5, fill: "#cbd5e1" }, mapSvg);
    if (mile % 5 === 0) {
      const t = svgEl("text", { x: x + 6, y: y - 5 }, mapSvg);
      t.textContent = mile;
    }
  }

  // Checkpoint badges, nudged apart where they overlap (with a leader line back to the spot)
  const offsets = [[0, 0], [0, -22], [22, 0], [0, 22], [-22, 0], [16, -16], [16, 16], [-16, 16], [-16, -16], [0, -40], [40, 0], [-40, 0]];
  const placed = [];
  const badges = svgEl("g", {}, mapSvg);
  COURSE_CHECKPOINTS.forEach((cp) => {
    const p = courseAt(cp.d);
    const [ax, ay] = project(p.lat, p.lon);
    const [dx, dy] = offsets.find(([ox2, oy2]) => placed.every(([px, py]) => Math.hypot(ax + ox2 - px, ay + oy2 - py) > 21)) || [0, 0];
    const bx = ax + dx;
    const by = ay + dy;
    if (dx || dy) {
      svgEl("line", { x1: ax, y1: ay, x2: bx, y2: by, stroke: "#e2e8f0", "stroke-width": 1 }, badges);
      svgEl("circle", { cx: ax, cy: ay, r: 2.5, fill: "#e2e8f0" }, badges);
    }
    placed.push([bx, by]);
    const g = drawBadge(badges, bx, by, cp.badge);
    svgEl("title", {}, g).textContent = `${cp.name} (mile ${cp.d.toFixed(1)})`;
  });

  const cursor = svgEl("circle", { r: 8, fill: "none", stroke: "#e2e8f0", "stroke-width": 2, visibility: "hidden" }, mapSvg);
  const dynamic = svgEl("g", {}, mapSvg);
  const xy = COURSE.points.map(([lat, lon]) => project(lat, lon));
  mapLayer = { dynamic, cursor, xy, project };

  // Hover: show every pass of the course near the pointer (it doubles back in places)
  const hit = svgEl("rect", { x: 0, y: 0, width, height, fill: "transparent" }, mapSvg);
  hit.addEventListener("pointermove", (e) => {
    const rect = mapSvg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const near = xy
      .map(([x, y], i) => ({ i, dist: Math.hypot(x - mx, y - my) }))
      .filter((n) => n.dist < 12)
      .sort((a, b2) => a.dist - b2.dist);
    if (!near.length) return hideCursors();
    const passes = [];
    near.forEach((n) => {
      const d = COURSE.distances[n.i];
      if (passes.every((p) => Math.abs(p - d) > 0.5)) passes.push(d);
    });
    const d = passes[0];
    passes.sort((a, b2) => a - b2);
    const here = courseAt(d);
    showCursors(d);
    showTooltip(mapTip, courseMap, mx, my,
      `<strong>Mile ${passes.map((p) => p.toFixed(1)).join(" & ")}</strong><br><span class="muted">${Math.round(here.ft)} ft</span>`);
  });
  hit.addEventListener("pointerleave", hideCursors);

  renderDynamic();
}

// ---------- elevation ----------

function renderElevation() {
  const width = elevChart.clientWidth;
  const height = elevChart.clientHeight;
  if (!width || !height) return;
  elevSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  elevSvg.replaceChildren();

  const m = { top: 34, right: 14, bottom: 22, left: 48 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const fts = COURSE.points.map((p) => p[2] * FT_PER_M);
  const lo = Math.floor((Math.min(...fts) - 10) / 25) * 25;
  const hi = Math.ceil((Math.max(...fts) + 10) / 25) * 25;
  const x = (d) => m.left + (d / MARATHON_MILES) * iw;
  const y = (ft) => m.top + ((hi - ft) / (hi - lo)) * ih;

  const step = [25, 50, 100].find((s) => (hi - lo) / s <= 4) || 100;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    svgEl("line", { x1: m.left, x2: m.left + iw, y1: y(t), y2: y(t), stroke: "#334155", "stroke-width": 1 }, elevSvg);
    svgEl("text", { x: m.left - 6, y: y(t) + 4, "text-anchor": "end" }, elevSvg).textContent = `${t} ft`;
  }
  for (let d = 0; d <= 25; d += 5) {
    svgEl("text", { x: x(d), y: height - 6, "text-anchor": "middle" }, elevSvg).textContent = d === 0 ? "Start" : `${d} mi`;
  }

  const line = COURSE.points.map((p, i) => `${i ? "L" : "M"}${x(COURSE.distances[i]).toFixed(1)},${y(p[2] * FT_PER_M).toFixed(1)}`).join("");
  svgEl("path", { d: `${line}L${x(MARATHON_MILES)},${m.top + ih}L${x(0)},${m.top + ih}Z`, fill: "#334155", "fill-opacity": 0.8 }, elevSvg);
  svgEl("path", { d: line, fill: "none", stroke: "#94a3b8", "stroke-width": 1.5, "stroke-linejoin": "round" }, elevSvg);

  // Checkpoint badges along the top, nudged right if they would overlap
  let lastX = -Infinity;
  COURSE_CHECKPOINTS.filter((cp) => cp.badge !== "S" && cp.badge !== "F").forEach((cp) => {
    const ax = x(cp.d);
    const bx = Math.max(ax, lastX + 20);
    lastX = bx;
    svgEl("path", {
      d: `M${bx},${m.top - 16}L${ax},${m.top - 4}L${ax},${y(courseAt(cp.d).ft)}`,
      fill: "none", stroke: "#64748b", "stroke-width": 1, "stroke-dasharray": "2 3",
    }, elevSvg);
    const g = drawBadge(elevSvg, bx, m.top - 22, cp.badge);
    svgEl("title", {}, g).textContent = `${cp.name} (mile ${cp.d.toFixed(1)})`;
  });

  const cursorLine = svgEl("line", { y1: m.top, y2: m.top + ih, stroke: "#e2e8f0", "stroke-width": 1, visibility: "hidden" }, elevSvg);
  const cursorDot = svgEl("circle", { r: 4, fill: "#e2e8f0", visibility: "hidden" }, elevSvg);
  const dynamic = svgEl("g", {}, elevSvg);
  elevLayer = { dynamic, cursorLine, cursorDot, x, y, top: m.top, bottom: m.top + ih };

  const hit = svgEl("rect", { x: m.left, y: 0, width: iw, height, fill: "transparent" }, elevSvg);
  hit.addEventListener("pointermove", (e) => {
    const rect = elevSvg.getBoundingClientRect();
    const d = Math.min(Math.max(((e.clientX - rect.left - m.left) / iw) * MARATHON_MILES, 0), MARATHON_MILES);
    const here = courseAt(d);
    showCursors(d);
    showTooltip(elevTip, elevChart, x(d), y(here.ft),
      `<strong>Mile ${d.toFixed(1)}</strong> · ${Math.round(here.ft)} ft<br><span class="muted">Grade ${formatGrade(gradeAt(d))}</span>`);
  });
  hit.addEventListener("pointerleave", hideCursors);

  renderDynamic();
}

// Linked hover marker on both the map and the elevation profile
function showCursors(d) {
  const here = courseAt(d);
  if (mapLayer) {
    const [mx, my] = mapLayer.project(here.lat, here.lon);
    mapLayer.cursor.setAttribute("cx", mx);
    mapLayer.cursor.setAttribute("cy", my);
    mapLayer.cursor.setAttribute("visibility", "visible");
  }
  if (elevLayer) {
    const ex = elevLayer.x(d);
    elevLayer.cursorLine.setAttribute("x1", ex);
    elevLayer.cursorLine.setAttribute("x2", ex);
    elevLayer.cursorDot.setAttribute("cx", ex);
    elevLayer.cursorDot.setAttribute("cy", elevLayer.y(here.ft));
    elevLayer.cursorLine.setAttribute("visibility", "visible");
    elevLayer.cursorDot.setAttribute("visibility", "visible");
  }
}

function hideCursors() {
  mapLayer?.cursor.setAttribute("visibility", "hidden");
  elevLayer?.cursorLine.setAttribute("visibility", "hidden");
  elevLayer?.cursorDot.setAttribute("visibility", "hidden");
  mapTip.hidden = true;
  elevTip.hidden = true;
}

// ---------- runners (everything that moves with the race clock) ----------

function renderDynamic() {
  const states = runners.map((r) => ({ ...r, d: distanceAtTime(r.segments, raceTime) }));
  // Draw slot 0 last so it sits on top
  const order = [...states].reverse();

  if (mapLayer) {
    mapLayer.dynamic.replaceChildren();
    order.forEach((r) => {
      const here = courseAt(r.d);
      const [x, y] = mapLayer.project(here.lat, here.lon);
      drawShape(mapLayer.dynamic, r.slot, x, y, 7);
    });
  }

  if (elevLayer) {
    elevLayer.dynamic.replaceChildren();
    order.forEach((r) => {
      const x = elevLayer.x(r.d);
      svgEl("line", { x1: x, x2: x, y1: elevLayer.top, y2: elevLayer.bottom, stroke: SERIES_COLORS[r.slot], "stroke-width": 1.5, "stroke-opacity": 0.7 }, elevLayer.dynamic);
      drawShape(elevLayer.dynamic, r.slot, x, elevLayer.y(courseAt(r.d).ft), 6);
    });
  }

  return states;
}

function renderRunnerTable(states) {
  const leader = states.reduce((a, b) => (b.d > a.d ? b : a));
  runnerBody.innerHTML = states
    .map((r) => {
      const finished = r.d >= MARATHON_MILES - 1e-6;
      const seg = r.segments.find((s) => r.d < s.distance) || r.segments[r.segments.length - 1];
      const here = courseAt(r.d);
      let gap;
      if (raceTime <= 0) gap = "—";
      else if (finished) gap = "Finished";
      else if (leader.d - r.d < 1e-6) gap = "Leading";
      else gap = `${(leader.d - r.d).toFixed(2)} mi · ${formatTime(raceTime - elapsedAt(leader.segments, r.d))}`;
      return `<tr>
        <td><span class="who">${swatchHtml(r.slot)}${r.label}${r.slot === 0 ? '<span class="tag">Yours</span>' : ""}</span></td>
        <td>${r.d.toFixed(2)}</td>
        <td>${finished ? "—" : formatTime(seg.pace)}</td>
        <td>${Math.round(here.ft)} ft <span class="muted">${finished ? "" : formatGrade(gradeAt(r.d))}</span></td>
        <td>${gap}</td>
      </tr>`;
    })
    .join("");
}

function renderCheckpointTable() {
  checkpointHead.innerHTML = `<tr>
    <th></th><th>Checkpoint</th><th>Mile</th>
    ${runners.map((r) => `<th><span class="who" title="${r.label}">${swatchHtml(r.slot)}${r.label}</span></th>`).join("")}
  </tr>`;
  checkpointBody.innerHTML = COURSE_CHECKPOINTS.map(
    (cp) => `<tr>
      <td><span class="badge">${cp.badge}</span></td>
      <td>${cp.name}</td>
      <td>${cp.d.toFixed(1)}</td>
      ${runners.map((r) => {
        const t = elapsedAt(r.segments, cp.d);
        return `<td class="cp-time" data-t="${t}">${formatTime(t, true)}</td>`;
      }).join("")}
    </tr>`
  ).join("");
}

function markReachedCheckpoints() {
  [...checkpointBody.rows].forEach((row) => {
    const cells = [...row.querySelectorAll(".cp-time")];
    cells.forEach((c) => c.classList.toggle("reached", raceTime >= Number(c.dataset.t) - 0.5));
    row.classList.toggle("passed", cells.every((c) => c.classList.contains("reached")));
  });
}

function updateRaceTime() {
  raceClock.textContent = formatTime(raceTime, true);
  timeOfDay.textContent = formatTimeOfDay(raceTime);
  const states = renderDynamic();
  renderRunnerTable(states);
  markReachedCheckpoints();
}

// ---------- controls ----------

function buildCompareChips() {
  compareChips.innerHTML = Object.entries(STRATEGIES)
    .map(([key, s]) => `<button type="button" data-key="${key}">${s.label}</button>`)
    .join("");
  compareChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    const key = btn.dataset.key;
    if (key === currentStrategy) return; // locked: change it in the Split strategy panel
    if (extras.has(key)) {
      extras.delete(key);
    } else if (extras.size < MAX_COMPARE - 1) {
      const used = new Set(extras.values());
      extras.set(key, SERIES_COLORS.findIndex((_, slot) => slot > 0 && !used.has(slot)));
    }
    refreshCourse();
  });
}

function renderChips() {
  [...compareChips.children].forEach((btn) => {
    const locked = btn.dataset.key === currentStrategy;
    const slot = locked ? 0 : extras.get(btn.dataset.key);
    const on = slot !== undefined;
    btn.setAttribute("aria-pressed", on);
    btn.setAttribute("aria-disabled", locked);
    btn.classList.toggle("locked", locked);
    btn.title = locked ? "Your split strategy. Change it in the Split strategy panel above." : "";
    btn.disabled = !on && extras.size >= MAX_COMPARE - 1;
    btn.querySelectorAll(".swatch, .lock").forEach((el) => el.remove());
    if (on) btn.insertAdjacentHTML("afterbegin", swatchHtml(slot));
    if (locked) btn.insertAdjacentHTML("beforeend", LOCK_ICON);
  });
}

// Recomputes every compared strategy for the current average pace and split strategy
function refreshCourse() {
  const pace = Number(slider.value);
  extras.delete(currentStrategy); // the picked strategy can't also be an extra
  runners = [[currentStrategy, 0], ...extras]
    .map(([key, slot]) => ({ key, slot, label: STRATEGIES[key].label, segments: computeSegments(pace, key) }))
    .sort((a, b) => a.slot - b.slot);

  const finish = Math.ceil(finishTime() / 10) * 10; // slider steps are 10 s, so round up to reach the line
  timeSlider.max = finish;
  if (raceTime === null) raceTime = Math.round((finish * 0.6) / 600) * 600;
  raceTime = Math.min(raceTime, finish);
  timeSlider.value = raceTime;

  renderChips();
  renderCheckpointTable();
  updateRaceTime();
}

function setPlaying(on) {
  playing = on;
  playButton.setAttribute("aria-pressed", on);
  playButton.setAttribute("aria-label", on ? "Pause race" : "Play race");
  if (on) {
    if (raceTime >= Number(timeSlider.max)) raceTime = 0;
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
}

function tick(now) {
  if (!playing) return;
  const max = Number(timeSlider.max);
  // the first frame's timestamp can precede the click, so never step backwards
  const elapsed = Math.max(0, now - lastFrame) / 1000;
  raceTime = Math.min(raceTime + elapsed * (finishTime() / PLAYBACK_SECONDS), max);
  lastFrame = now;
  timeSlider.value = raceTime;
  updateRaceTime();
  if (raceTime >= max) setPlaying(false);
  else requestAnimationFrame(tick);
}

timeSlider.addEventListener("input", () => {
  setPlaying(false);
  raceTime = Number(timeSlider.value);
  updateRaceTime();
});
playButton.addEventListener("click", () => setPlaying(!playing));
document.addEventListener("planchange", refreshCourse);

document.getElementById("courseStats").textContent =
  `${COURSE.stats.gainFt} ft of climbing · ${COURSE.stats.minFt}–${COURSE.stats.maxFt} ft elevation`;
courseMap.style.aspectRatio = `${MAP_BOUNDS.w} / ${MAP_BOUNDS.h}`;

buildCompareChips();
refreshCourse();
new ResizeObserver(renderMap).observe(courseMap);
new ResizeObserver(renderElevation).observe(elevChart);
