import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const username = process.env.GITHUB_USERNAME ?? "cenyangzer";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = resolve(root, "assets");
const pageUrl = `https://github.com/users/${encodeURIComponent(username)}/contributions`;
const cellPattern = /<td\b([^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*)>/g;
const levelPattern = /\bdata-level="([0-4])"/;

const response = await fetch(pageUrl, {
  headers: {
    accept: "text/html",
    "user-agent": "profile-contribution-trail/1.0"
  },
  signal: AbortSignal.timeout(30_000)
});

if (!response.ok) {
  throw new Error(`GitHub returned ${response.status} for ${pageUrl}`);
}

const html = await response.text();
const cells = [];
for (const match of html.matchAll(cellPattern)) {
  const level = match[1].match(levelPattern)?.[1];
  const componentId = match[1].match(/\bid="([^"]+)"/)?.[1];
  if (level === undefined || componentId === undefined) {
    throw new Error(`Contribution metadata missing for ${match[2]}`);
  }
  cells.push({ date: match[2], level: Number(level), componentId });
}

const countsByComponent = new Map();
const tooltipPattern = /<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/g;
for (const match of html.matchAll(tooltipPattern)) {
  const componentId = match[1].match(/\bfor="([^"]+)"/)?.[1];
  const text = match[2]
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  if (componentId === undefined) continue;

  const count = text.match(/^([\d,]+)\s+contributions?\b/i)?.[1];
  if (count !== undefined) {
    countsByComponent.set(componentId, Number(count.replace(/,/g, "")));
  } else if (/^no contributions\b/i.test(text)) {
    countsByComponent.set(componentId, 0);
  }
}

for (const day of cells) {
  const count = countsByComponent.get(day.componentId);
  if (count === undefined || (count > 0) !== (day.level > 0)) {
    throw new Error(`Daily contribution count missing or inconsistent for ${day.date}`);
  }
  day.count = count;
}

cells.sort((left, right) => left.date.localeCompare(right.date));

if (cells.length < 350) {
  throw new Error(`Expected a full contribution year, found ${cells.length} days`);
}

for (let index = 1; index < cells.length; index += 1) {
  const previous = Date.parse(`${cells[index - 1].date}T00:00:00Z`);
  const current = Date.parse(`${cells[index].date}T00:00:00Z`);
  if (current - previous !== 86_400_000) {
    throw new Error(`Contribution dates are not consecutive at ${cells[index].date}`);
  }
}

const firstDate = new Date(`${cells[0].date}T00:00:00Z`);
if (firstDate.getUTCDay() !== 0) {
  throw new Error(`Contribution calendar does not start on Sunday: ${cells[0].date}`);
}

const activityHeading = html.match(
  /id="js-contribution-activity-description"[^>]*>([\s\S]*?)<\/h2>/
)?.[1];
const contributionTotal = activityHeading
  ? Number(activityHeading.replace(/<[^>]*>/g, "").replace(/[^\d]/g, ""))
  : NaN;
if (!Number.isFinite(contributionTotal)) {
  throw new Error("Could not read the annual contribution total from GitHub");
}
if (cells.reduce((sum, day) => sum + day.count, 0) !== contributionTotal) {
  throw new Error("Daily contribution counts do not match GitHub's annual total");
}

const themes = {
  light: {
    background: "#f3eee4",
    ink: "#1b1712",
    muted: "#746b60",
    route: "#b64a3a",
    levels: ["#e7dccb", "#cbbba3", "#a38f77", "#6f5c47", "#2a211a"]
  },
  dark: {
    background: "#0c1210",
    ink: "#e8e2d4",
    muted: "#8d948b",
    route: "#c9a36a",
    levels: ["#1a2420", "#2c4036", "#4d6a58", "#8fa88e", "#e8e2d4"]
  }
};

const grid = {
  x: 34,
  y: 58,
  cell: 14,
  gap: 5,
  get step() {
    return this.cell + this.gap;
  }
};
const width = 1200;
const height = 224;
const datePosition = new Map(
  cells.map((day, index) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const week = Math.floor(index / 7);
    const weekday = date.getUTCDay();
    return [
      day.date,
      {
        x: grid.x + week * grid.step + grid.cell / 2,
        y: grid.y + weekday * grid.step + grid.cell / 2,
        week,
        weekday
      }
    ];
  })
);

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  })[character]);
}

function routePath(activeDays) {
  const points = activeDays.map((day) => datePosition.get(day.date));
  if (points.length === 0) return { path: "", keyPoints: "", keyTimes: "" };
  if (points.length === 1) {
    return {
      path: `M ${points[0].x} ${points[0].y}`,
      keyPoints: "0",
      keyTimes: "0"
    };
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  const cumulativeLengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    let distance = 0;
    if (previous.x === current.x || previous.y === current.y) {
      path += ` L ${current.x} ${current.y}`;
      distance = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    } else {
      const elbowX = (previous.x + current.x) / 2;
      path += ` H ${elbowX} V ${current.y} H ${current.x}`;
      distance = Math.abs(elbowX - previous.x) + Math.abs(current.y - previous.y) + Math.abs(current.x - elbowX);
    }
    cumulativeLengths.push(cumulativeLengths.at(-1) + distance);
  }

  const totalLength = cumulativeLengths.at(-1);
  const firstTime = Date.parse(`${activeDays[0].date}T00:00:00Z`);
  const lastTime = Date.parse(`${activeDays.at(-1).date}T00:00:00Z`);
  const totalTime = lastTime - firstTime;
  return {
    path,
    keyPoints: cumulativeLengths.map((length) => (length / totalLength).toFixed(4)).join(";"),
    keyTimes: activeDays.map((day) => {
      const time = Date.parse(`${day.date}T00:00:00Z`);
      return ((time - firstTime) / totalTime).toFixed(4);
    }).join(";")
  };
}

const activeDays = cells.filter((day) => day.count > 0);
const route = routePath(activeDays);
const monthLabels = [];
let lastMonth = "";
for (const day of cells) {
  const date = new Date(`${day.date}T00:00:00Z`);
  const month = date.getUTCMonth();
  const key = `${date.getUTCFullYear()}-${month}`;
  if (key !== lastMonth) {
    const position = datePosition.get(day.date);
    monthLabels.push(
      `<text x="${grid.x + position.week * grid.step}" y="38" class="month">${date.toLocaleString("en", { month: "short", timeZone: "UTC" })}</text>`
    );
    lastMonth = key;
  }
}

const generatedAt = new Date().toISOString().slice(0, 10);
const summary = `${contributionTotal.toLocaleString("en")} contributions · ${cells[0].date} — ${cells.at(-1).date}`;

function createSvg(themeName, animated) {
  const theme = themes[themeName];
  const dayCells = cells.map((day) => {
    const position = datePosition.get(day.date);
    const { x, y } = position;
    const countLabel = day.count === 0 ? "No contributions" : `${day.count} contribution${day.count === 1 ? "" : "s"}`;
    const pulse = animated && day.count > 0
      ? `<animate attributeName="opacity" values=".72;1;.72" dur="3.8s" begin="-${((position.week * 0.37) % 3.8).toFixed(2)}s" repeatCount="indefinite"/>`
      : "";
    return `<rect x="${x - grid.cell / 2}" y="${y - grid.cell / 2}" width="${grid.cell}" height="${grid.cell}" rx="3" fill="${theme.levels[day.level]}">${pulse}<title>${day.date}: ${countLabel} (level ${day.level})</title></rect>`;
  }).join("");

  const routeMarkup = route.path
    ? `<path d="${route.path}" fill="none" stroke="${theme.route}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity=".26"/>${animated ? `<path d="${route.path}" pathLength="1" fill="none" stroke="${theme.route}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray=".018 .982" opacity=".8" class="route-flow"><animate attributeName="stroke-dashoffset" values="0;-1" dur="7.5s" repeatCount="indefinite"/></path>` : ""}`
    : "";
  const runner = route
    ? animated
      ? `<g class="motion-marker"><animateMotion dur="72s" repeatCount="indefinite" calcMode="linear" keyPoints="${route.keyPoints}" keyTimes="${route.keyTimes}" path="${route.path}"/><circle r="8" fill="${theme.route}" opacity=".16"><animate attributeName="r" values="5;9;5" dur="2.8s" repeatCount="indefinite"/><animate attributeName="opacity" values=".1;.25;.1" dur="2.8s" repeatCount="indefinite"/></circle><circle r="3.2" fill="${theme.route}"/></g><circle r="2.2" fill="${theme.route}" opacity=".48" class="motion-marker"><animateMotion dur="72s" begin="-3s" repeatCount="indefinite" calcMode="linear" keyPoints="${route.keyPoints}" keyTimes="${route.keyTimes}" path="${route.path}"/></circle><circle r="1.5" fill="${theme.route}" opacity=".25" class="motion-marker"><animateMotion dur="72s" begin="-6s" repeatCount="indefinite" calcMode="linear" keyPoints="${route.keyPoints}" keyTimes="${route.keyTimes}" path="${route.path}"/></circle><circle cx="${datePosition.get(activeDays.at(-1).date).x}" cy="${datePosition.get(activeDays.at(-1).date).y}" r="3" fill="${theme.route}" class="static-marker"/>`
      : `<circle cx="${datePosition.get(activeDays.at(-1).date).x}" cy="${datePosition.get(activeDays.at(-1).date).y}" r="3" fill="${theme.route}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(username)} · Build Trail</title>
  <desc id="description">A trail connecting days with real GitHub contributions. ${escapeXml(summary)}. Generated ${generatedAt}.</desc>
  <style>
    text{font-family:Arial,sans-serif}.month{fill:${theme.muted};font-size:10px;letter-spacing:.3px}.summary{fill:${theme.muted};font-size:11px}.level-label{fill:${theme.muted};font-size:10px}.static-marker{display:${animated ? "none" : "block"}}
${animated ? "    @media(prefers-reduced-motion:reduce){.motion-marker,.route-flow{display:none}.static-marker{display:block}}\n" : ""}  </style>
  <rect width="${width}" height="${height}" rx="8" fill="${theme.background}"/>
  <text x="34" y="20" fill="${theme.ink}" font-size="11" letter-spacing="2">BUILD TRAIL　/　REAL CONTRIBUTIONS</text>
  ${monthLabels.join("\n  ")}
  ${routeMarkup}
  ${dayCells}
  ${runner}
  <text x="34" y="207" class="summary">${escapeXml(summary)}</text>
  <text x="770" y="207" class="level-label">LESS</text>
  ${theme.levels.map((color, level) => `<rect x="${812 + level * 19}" y="196" width="13" height="13" rx="3" fill="${color}"><title>Contribution level ${level}</title></rect>`).join("")}
  <text x="915" y="207" class="level-label">MORE</text>
  <text x="1000" y="207" class="level-label">ROUTE CONNECTS ACTIVE DAYS</text>
</svg>`;
}

await mkdir(assetDirectory, { recursive: true });
const outputs = [
  ["contribution-trail-light.svg", createSvg("light", true)],
  ["contribution-trail-dark.svg", createSvg("dark", true)],
  ["contribution-trail-static-light.svg", createSvg("light", false)],
  ["contribution-trail-static-dark.svg", createSvg("dark", false)]
];

for (const [filename, svg] of outputs) {
  await writeFile(resolve(assetDirectory, filename), `${svg}\n`, "utf8");
}

console.log(`Generated ${outputs.length} trail assets from ${cells.length} real days (${contributionTotal} contributions).`);
