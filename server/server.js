const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY || "";
const BASE_URL = "https://api.football-data.org/v4";
const CACHE_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQ_PER_WINDOW = 45;

const cache = new Map();
const rateMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQ_PER_WINDOW;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/football", async (req, res) => {
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const league = String(req.query.league || "PL").toUpperCase();
  const allowed = new Set(["PL", "PD", "SA", "BL1", "FL1", "CL"]);
  if (!allowed.has(league)) return res.status(400).json({ error: "Unsupported league" });
  if (!API_KEY) return res.status(500).json({ error: "Missing FOOTBALL_DATA_KEY" });

  const now = Date.now();
  const hit = cache.get(league);
  if (hit && now - hit.savedAt < CACHE_TTL_MS) {
    return res.json(hit.payload);
  }

  try {
    const [standingsRaw, matchesRaw] = await Promise.all([
      fetchJson(`${BASE_URL}/competitions/${league}/standings`),
      fetchJson(`${BASE_URL}/competitions/${league}/matches?status=SCHEDULED`)
    ]);

    const mainTable =
      (standingsRaw.standings &&
        (standingsRaw.standings.find((s) => s.type === "TOTAL") || standingsRaw.standings[0])
          ?.table) ||
      [];

    const standings = mainTable.map((r) => ({
      rank: r.position,
      team: r.team?.shortName || r.team?.name || "",
      played: r.playedGames,
      won: r.won,
      draw: r.draw,
      lost: r.lost,
      goalDifference: r.goalDifference,
      points: r.points
    }));

    const fixtures = (matchesRaw.matches || []).slice(0, 20).map((m) => {
      const dt = new Date(m.utcDate);
      return {
        homeTeam: m.homeTeam?.shortName || m.homeTeam?.name || "",
        awayTeam: m.awayTeam?.shortName || m.awayTeam?.name || "",
        date: isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10),
        time: isNaN(dt.getTime()) ? "" : dt.toISOString().slice(11, 16) + " UTC"
      };
    });

    const payload = { league, updatedAt: new Date().toISOString(), standings, fixtures };
    cache.set(league, { savedAt: now, payload });
    return res.json(payload);
  } catch (err) {
    if (hit) return res.json({ ...hit.payload, stale: true });
    return res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`MatchPulse backend running on ${PORT}`));
