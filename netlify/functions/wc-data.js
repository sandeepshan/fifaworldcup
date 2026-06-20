// Netlify serverless function — single source of truth for World Cup data.
// Uses football-data.org's free tier, which explicitly includes the World
// Cup (competition code "WC") at no cost — confirmed via their own docs
// and blog: "What was free in v1, remains free in v2 and will remain
// free forever." No credit card required.
//
// Free tier limits: 10 requests/minute for registered (free) accounts.
// This function caches for 90s and is the ONLY thing that calls the
// upstream API — every visitor shares one cache, so even many visitors
// never approach that limit.
//
// SETUP REQUIRED (one-time):
// 1. Sign up free at https://www.football-data.org/client/register
// 2. Copy your API token from your account page
// 3. In Netlify: Site settings → Environment variables → add
//    FOOTBALL_DATA_TOKEN with that token
// 4. Deploy — this function will be live at /.netlify/functions/wc-data

const API_BASE = 'https://api.football-data.org/v4';
const COMPETITION_CODE = 'WC'; // FIFA World Cup

// In-memory cache (persists across warm Netlify function invocations)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 90 * 1000; // serve cached data for 90s between upstream calls

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  };

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        error: 'FOOTBALL_DATA_TOKEN not configured',
        fixtures: [],
        standings: [],
        stale: true,
      }),
    };
  }

  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
  }

  try {
    const [matchesRes, standingsRes] = await Promise.all([
      fetch(`${API_BASE}/competitions/${COMPETITION_CODE}/matches`, {
        headers: { 'X-Auth-Token': token },
      }),
      fetch(`${API_BASE}/competitions/${COMPETITION_CODE}/standings`, {
        headers: { 'X-Auth-Token': token },
      }),
    ]);

    if (!matchesRes.ok) {
      throw new Error(`Matches endpoint error: ${matchesRes.status}`);
    }

    const matchesJson = await matchesRes.json();
    // Standings may 404 before the group stage table exists yet — handle gracefully
    const standingsJson = standingsRes.ok ? await standingsRes.json() : { standings: [] };

    const fixtures = (matchesJson.matches || []).map(m => ({
      id: m.id,
      home: m.homeTeam && m.homeTeam.name,
      away: m.awayTeam && m.awayTeam.name,
      homeScore: m.score && m.score.fullTime ? m.score.fullTime.home : null,
      awayScore: m.score && m.score.fullTime ? m.score.fullTime.away : null,
      status: m.status,            // SCHEDULED, LIVE, IN_PLAY, PAUSED, FINISHED, etc.
      minute: m.minute || null,
      kickoffUtc: m.utcDate,
      venue: m.venue || null,
      group: m.group || null,
      stage: m.stage || null,
    }));

    const standings = (standingsJson.standings || []).map(group =>
      (group.table || []).map(row => ({
        team: row.team && row.team.name,
        rank: row.position,
        played: row.playedGames,
        win: row.won,
        draw: row.draw,
        lose: row.lost,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
        points: row.points,
      }))
    );

    const result = {
      fixtures,
      standings,
      fetchedAt: new Date().toISOString(),
      stale: false,
    };

    cache = { data: result, timestamp: now };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    // Upstream failed — serve last good cache rather than nothing
    if (cache.data) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ...cache.data, stale: true, error: err.message }),
      };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ fixtures: [], standings: [], stale: true, error: err.message }),
    };
  }
};
