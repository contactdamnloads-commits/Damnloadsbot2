// api/stats.js
// Expose les statistiques de téléchargement pour le bot Discord et le panel admin

const { parse }  = require('cookie');
const { verify } = require('jsonwebtoken');

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_OWNER   = process.env.GITHUB_OWNER;
const GITHUB_REPO    = process.env.GITHUB_REPO;
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';
const LOGS_PATH      = 'download_logs.json';
const SESSION_SECRET = process.env.SESSION_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const BOT_SECRET     = process.env.BOT_SECRET; // secret partagé avec le bot

// Seuils de grade
const ROLE_THRESHOLDS = [
  { min: 50, roleId: '1499013551933624380', label: 'Maître DamnLoads' },
  { min: 10, roleId: '1499013453065748562', label: 'Accro DamnLoads' },
  { min: 1,  roleId: '1499013275004964984', label: 'Téléchargeur' },
];

// ─── GitHub helper ────────────────────────────────────────────────────────────

async function getLogsFromGitHub() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${LOGS_PATH}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub GET logs → ${res.status}`);
  const json = await res.json();
  const parsed = JSON.parse(Buffer.from(json.content, 'base64').toString('utf8'));
  return parsed.logs ?? [];
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function isAdminSession(req) {
  try {
    const cookies = parse(req.headers.cookie || '');
    const token = cookies.dl_session;
    if (!token) return false;
    const user = verify(token, SESSION_SECRET);
    return ['admin', 'owner'].includes(user.siteRole);
  } catch { return false; }
}

function isBotRequest(req) {
  if (!BOT_SECRET) return false;
  return req.headers['x-bot-secret'] === BOT_SECRET;
}

// ─── Calcul des stats ─────────────────────────────────────────────────────────

function computeStats(logs) {
  const byUser  = {};
  const byGame  = {};
  const recent  = logs.slice(-50).reverse();

  for (const log of logs) {
    // ─ par utilisateur
    if (!byUser[log.discordId]) {
      byUser[log.discordId] = {
        discordId:       log.discordId,
        discordUsername: log.discordUsername,
        discordGlobalName: log.discordGlobalName || log.discordUsername,
        discordAvatar:   log.discordAvatar,
        count:           0,
        games:           [],
        firstDL:         log.timestamp,
        lastDL:          log.timestamp,
        earnedRole:      null,
      };
    }
    byUser[log.discordId].count++;
    byUser[log.discordId].lastDL = log.timestamp;
    if (!byUser[log.discordId].games.find(g => g.gameId === log.gameId)) {
      byUser[log.discordId].games.push({ gameId: log.gameId, gameName: log.gameName });
    }

    // ─ par jeu
    if (!byGame[log.gameId]) {
      byGame[log.gameId] = {
        gameId:   log.gameId,
        gameName: log.gameName,
        gameType: log.gameType,
        gameCat:  log.gameCat,
        count:    0,
        users:    [],
      };
    }
    byGame[log.gameId].count++;
    if (!byGame[log.gameId].users.includes(log.discordId)) {
      byGame[log.gameId].users.push(log.discordId);
    }
  }

  // Calcul du grade gagné pour chaque user
  for (const u of Object.values(byUser)) {
    for (const threshold of ROLE_THRESHOLDS) {
      if (u.count >= threshold.min) {
        u.earnedRole = threshold;
        break;
      }
    }
  }

  const topUsers = Object.values(byUser).sort((a, b) => b.count - a.count).slice(0, 50);
  const topGames = Object.values(byGame).sort((a, b) => b.count - a.count).slice(0, 50);

  return {
    totalDownloads: logs.length,
    totalUniqueUsers: Object.keys(byUser).length,
    totalUniqueGames: Object.keys(byGame).length,
    topUsers,
    topGames,
    recent,
    roleThresholds: ROLE_THRESHOLDS,
    allUsers: Object.values(byUser), // pour le bot (attribution de rôles)
    generatedAt: new Date().toISOString(),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // Auth : admin connecté via Discord OU bot avec son secret
  if (!isAdminSession(req) && !isBotRequest(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const logs  = await getLogsFromGitHub();
    const stats = computeStats(logs);
    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    console.error('[stats]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
