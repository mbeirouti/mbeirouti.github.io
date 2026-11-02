// Official marathon distance: 42.195 km = 26.21875 miles
const MARATHON_MILES = 42.195 / 1.609344;
const KM_PER_MILE = 1.609344;
const SVG_NS = "http://www.w3.org/2000/svg";

const slider = document.getElementById("paceSlider");
const paceValue = document.getElementById("paceValue");
const kmPace = document.getElementById("kmPace");
const marathonTime = document.getElementById("marathonTime");
const halves = document.getElementById("halves");
const splitsBody = document.getElementById("splitsBody");
const strategyButtons = document.getElementById("strategyButtons");
const strategyDesc = document.getElementById("strategyDesc");
const chart = document.getElementById("chart");
const chartSvg = document.getElementById("chartSvg");
const tooltip = document.getElementById("tooltip");

// Each strategy is a relative pace profile over the race, x = 0 (start) .. 1 (finish).
// Values > 1 are slower than average, < 1 faster. Profiles are normalised so the
// total time always matches the slider's average pace.
const STRATEGIES = {
  even: {
    label: "Even",
    desc: "Same pace every mile.",
    profile: () => 1,
  },
  negative: {
    label: "Negative split",
    desc: "Second half about 3% faster than the first.",
    profile: (x) => (x < 0.5 ? 1.015 : 0.985),
  },
  positive: {
    label: "Positive split",
    desc: "First half about 3% faster than the second.",
    profile: (x) => (x < 0.5 ? 0.985 : 1.015),
  },
  progressive: {
    label: "Progressive",
    desc: "Start about 3% slow and build steadily to about 3% fast.",
    profile: (x) => 1.03 - 0.06 * x,
  },
  kick: {
    label: "Strong finish",
    desc: "Steady to mile 24, then kick about 5% faster to the line.",
    profile: (x) => (x < 24 / MARATHON_MILES ? 1 : 0.95),
  },
  wall: {
    label: "Hit the wall",
    desc: "Go out a little fast, then fade hard over the last 10K.",
    profile: (x) => (x < 0.75 ? 0.98 : 0.98 + 0.14 * ((x - 0.75) / 0.25)),
  },
  smoothNegative: {
    label: "Smooth negative",
    desc: "Eases from about 1.5% slow to about 1.5% fast, with the change concentrated around halfway.",
    profile: (x) => 1.015 - 0.03 / (1 + Math.exp(-(x - 0.5) * 12)),
  },
  fatigue: {
    label: "Gradual fade",
    desc: "Starts slightly quick and slows progressively, with the slowdown accelerating late.",
    profile: (x) => 0.985 + 0.06 * x ** 3,
  },
  surgeSettle: {
    label: "Negative, then settle",
    desc: "A smooth negative split that peaks around mile 18, then gently eases off all the way to the finish.",
    profile: (x) =>
      1.015 - 0.03 / (1 + Math.exp(-(x - 0.5) * 12)) + // smooth negative split (same as above)
      0.01 * smoothstep(0.66, 1, x), //                   gentle ease-off over the last ~9 miles
  },
  positiveSettle: {
    label: "Positive, then settle",
    desc: "A smooth positive split that is slowest around mile 18, then gently picks back up to the finish.",
    profile: (x) =>
      0.985 + 0.03 / (1 + Math.exp(-(x - 0.5) * 12)) - // smooth positive split (mirror of smooth negative)
      0.01 * smoothstep(0.66, 1, x), //                   gentle pick-up over the last ~9 miles
  },
};

// Gaussian bump centred at c with width w and height h
function bump(x, c, w, h) {
  return h * Math.exp(-(((x - c) / w) ** 2));
}

// Smooth 0 -> 1 transition between a and b
function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

let currentStrategy = "even";
let currentSegments = [];

// Formats seconds as h:mm:ss (or m:ss when under an hour unless forceHours)
function formatTime(totalSeconds, forceHours = false) {
  const sign = totalSeconds < 0 ? "−" : "";
  const s = Math.round(Math.abs(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0 || forceHours) {
    return `${sign}${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }
  return `${sign}${minutes}:${ss}`;
}

// Checkpoints: miles 1-26, then the finish at 26.2
function checkpoints() {
  const points = [];
  for (let mile = 1; mile <= 26; mile++) {
    points.push({ label: String(mile), distance: mile });
  }
  points.push({ label: "26.2 (Finish)", distance: MARATHON_MILES, finish: true });
  return points;
}

const CHECKPOINTS = checkpoints();

// Builds per-segment pace, split and elapsed time for a given average pace and strategy
function computeSegments(avgPace, strategyKey) {
  const profile = STRATEGIES[strategyKey].profile;
  let start = 0;
  const segments = CHECKPOINTS.map((cp) => {
    const dist = cp.distance - start;
    const seg = { ...cp, start, dist, rel: profile((start + dist / 2) / MARATHON_MILES) };
    start = cp.distance;
    return seg;
  });

  const scale = MARATHON_MILES / segments.reduce((sum, s) => sum + s.dist * s.rel, 0);
  let elapsed = 0;
  segments.forEach((s) => {
    s.pace = avgPace * s.rel * scale;
    s.split = s.pace * s.dist;
    elapsed += s.split;
    s.elapsed = elapsed;
  });
  return segments;
}

function elapsedAt(segments, distance) {
  const seg = segments.find((s) => distance <= s.distance) || segments[segments.length - 1];
  return seg.elapsed - seg.split + (distance - seg.start) * seg.pace;
}

function buildStrategyButtons() {
  strategyButtons.innerHTML = Object.entries(STRATEGIES)
    .map(([key, s]) => `<button type="button" data-key="${key}">${s.label}</button>`)
    .join("");
  strategyButtons.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    currentStrategy = btn.dataset.key;
    update();
  });
}

function buildTable() {
  splitsBody.innerHTML = CHECKPOINTS.map(
    (cp) => `<tr${cp.finish ? ' class="finish"' : ""}>
      <td>${cp.label}</td>
      <td class="pace"></td>
      <td class="split"></td>
      <td class="elapsed"></td>
    </tr>`
  ).join("");
}

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// Picks a tick step (seconds) giving roughly 3-4 gridlines across the range
function paceTickStep(range) {
  const steps = [2, 5, 10, 15, 20, 30, 60];
  return steps.find((s) => range / s <= 4) || 60;
}

function renderChart() {
  const segments = currentSegments;
  if (!segments.length) return;
  const avgPace = Number(slider.value);
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const m = { top: 10, right: 12, bottom: 22, left: 40 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;

  chartSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  chartSvg.replaceChildren();

  // Pace domain, with a minimum span so an even pace sits flat in the middle
  const paces = segments.map((s) => s.pace);
  let lo = Math.min(...paces, avgPace);
  let hi = Math.max(...paces, avgPace);
  const span = Math.max(hi - lo, 20);
  const mid = (hi + lo) / 2;
  lo = mid - span * 0.6;
  hi = mid + span * 0.6;

  const x = (d) => m.left + (d / MARATHON_MILES) * iw;
  const y = (p) => m.top + ((p - lo) / (hi - lo)) * ih; // faster (lower pace) at the top

  // Gridlines + y labels
  const step = paceTickStep(hi - lo);
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    svgEl("line", { x1: m.left, x2: m.left + iw, y1: y(t), y2: y(t), stroke: "#334155", "stroke-width": 1 }, chartSvg);
    const label = svgEl("text", { x: m.left - 6, y: y(t) + 4, "text-anchor": "end" }, chartSvg);
    label.textContent = formatTime(t);
  }

  // X labels
  for (let d = 0; d <= 25; d += 5) {
    const label = svgEl("text", { x: x(d), y: height - 6, "text-anchor": "middle" }, chartSvg);
    label.textContent = d === 0 ? "Start" : `${d} mi`;
  }

  // Average pace reference
  svgEl("line", {
    x1: m.left, x2: m.left + iw, y1: y(avgPace), y2: y(avgPace),
    stroke: "#94a3b8", "stroke-width": 1, "stroke-dasharray": "4 4",
  }, chartSvg);

  // Pace line through each segment's midpoint, extended to start and finish
  const pts = segments.map((s) => [x(s.start + s.dist / 2), y(s.pace)]);
  pts.unshift([x(0), pts[0][1]]);
  pts.push([x(MARATHON_MILES), pts[pts.length - 1][1]]);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");

  svgEl("path", {
    d: `${line}L${x(MARATHON_MILES)},${m.top + ih}L${x(0)},${m.top + ih}Z`,
    fill: "#38bdf8", "fill-opacity": 0.12,
  }, chartSvg);
  svgEl("path", {
    d: line, fill: "none", stroke: "#38bdf8", "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }, chartSvg);

  // Hover layer
  const crosshair = svgEl("line", {
    y1: m.top, y2: m.top + ih, stroke: "#94a3b8", "stroke-width": 1, visibility: "hidden",
  }, chartSvg);
  const dot = svgEl("circle", {
    r: 4.5, fill: "#38bdf8", stroke: "#1e293b", "stroke-width": 2, visibility: "hidden",
  }, chartSvg);
  const hit = svgEl("rect", { x: m.left, y: 0, width: iw, height, fill: "transparent" }, chartSvg);

  hit.addEventListener("pointermove", (e) => {
    const rect = chartSvg.getBoundingClientRect();
    const d = ((e.clientX - rect.left - m.left) / iw) * MARATHON_MILES;
    const i = Math.max(0, segments.findIndex((s) => d <= s.distance));
    const s = segments[i] || segments[segments.length - 1];
    const px = x(s.start + s.dist / 2);
    const py = y(s.pace);

    crosshair.setAttribute("x1", px);
    crosshair.setAttribute("x2", px);
    crosshair.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px);
    dot.setAttribute("cy", py);
    dot.setAttribute("visibility", "visible");

    tooltip.innerHTML = `<strong>Mile ${s.label}</strong> · ${formatTime(s.pace)}/mi<br><span class="muted">Elapsed ${formatTime(s.elapsed, true)}</span>`;
    tooltip.hidden = false;
    const half = tooltip.offsetWidth / 2;
    tooltip.style.left = `${Math.min(Math.max(px, half), width - half)}px`;
    tooltip.style.top = `${py > height / 2 ? 0 : height - tooltip.offsetHeight - m.bottom}px`;

    highlightRow(i);
  });
  hit.addEventListener("pointerleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
    highlightRow(-1);
  });
}

function highlightRow(index) {
  [...splitsBody.rows].forEach((row, i) => row.classList.toggle("highlight", i === index));
}

function update() {
  const pace = Number(slider.value); // average seconds per mile
  currentSegments = computeSegments(pace, currentStrategy);

  paceValue.textContent = formatTime(pace);
  kmPace.textContent = formatTime(pace / KM_PER_MILE);
  marathonTime.textContent = formatTime(pace * MARATHON_MILES, true);

  const halfTime = elapsedAt(currentSegments, MARATHON_MILES / 2);
  const secondHalf = pace * MARATHON_MILES - halfTime;
  const diff = secondHalf - halfTime;
  halves.innerHTML = `Halfway <strong>${formatTime(halfTime, true)}</strong> · Second half <strong>${formatTime(secondHalf, true)}</strong> (${diff >= 0.5 ? "+" : ""}${formatTime(diff)})`;

  [...strategyButtons.children].forEach((btn) =>
    btn.setAttribute("aria-pressed", btn.dataset.key === currentStrategy)
  );
  strategyDesc.textContent = STRATEGIES[currentStrategy].desc;

  const rows = splitsBody.rows;
  currentSegments.forEach((s, i) => {
    rows[i].querySelector(".pace").textContent = formatTime(s.pace);
    rows[i].querySelector(".split").textContent = formatTime(s.split);
    rows[i].querySelector(".elapsed").textContent = formatTime(s.elapsed, true);
  });

  renderChart();
  document.dispatchEvent(new Event("planchange")); // pace or strategy changed
}

function nudge(delta) {
  slider.value = Number(slider.value) + delta;
  update();
}

slider.addEventListener("input", update);
document.getElementById("minusSecond").addEventListener("click", () => nudge(-1));
document.getElementById("plusSecond").addEventListener("click", () => nudge(1));
new ResizeObserver(renderChart).observe(chart);

// Mile splits start collapsed; remember if the viewer opens them
const splits = document.getElementById("splits");
try {
  splits.open = localStorage.getItem("splitsOpen") === "1";
} catch {}
splits.addEventListener("toggle", () => {
  try {
    localStorage.setItem("splitsOpen", splits.open ? "1" : "0");
  } catch {}
});

buildStrategyButtons();
buildTable();
update();
