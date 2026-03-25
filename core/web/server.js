/**
 * Reze Dashboard Web Server
 * Serves the dashboard at http://localhost:3000
 * and exposes a REST API for live bot data.
 *
 * Token endpoints now hot-start / hot-stop bots — no restart required.
 */

import http     from 'http';
import fs       from 'fs-extra';
import path     from 'path';
import TelegramBot from 'node-telegram-bot-api';
import Groq        from 'groq-sdk';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.join(__dirname, '..', '..');

const PORT = process.env.REZE_DASH_PORT || 3000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Token file helpers ────────────────────────────────────────────────────────

function getTokensFromFile() {
  try {
    const tokensPath = path.join(ROOT, 'json', 'tokens.json');
    let tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    if (!Array.isArray(tokens)) tokens = [tokens];
    return tokens.filter(t => t && t !== 'YOUR_BOT_TOKEN_HERE');
  } catch { return []; }
}

function saveTokensToFile(tokens) {
  const tokensPath = path.join(ROOT, 'json', 'tokens.json');
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
}

// ── Hot-start / hot-stop (mirrors token command, no restart required) ─────────

async function hotStartBotFromWeb(token) {
  // IMPORTANT: use .default — handlerAction.js uses `export default`
  const mod = await import(
    pathToFileURL(path.join(ROOT, 'core', 'system', 'handlerAction.js')).href
  );
  const createHandlerAction = mod.default;

  const groqKey = global.Reze?.config?.groqKey || global.Reze?.api?.groq || '';
  const groq    = groqKey ? new Groq({ apiKey: groqKey }) : null;

  const bot = new TelegramBot(token, { polling: true });
  const me  = await bot.getMe();   // throws immediately if token is invalid

  const handlerAction = createHandlerAction(bot, groq);

  bot.on('message',          msg => handlerAction({ message: msg }));
  bot.on('edited_message',   msg => handlerAction({ edited_message: msg }));
  bot.on('callback_query',   cbq => handlerAction({ callback_query: cbq }));
  bot.on('message_reaction', rxn => handlerAction({ message_reaction: rxn }));
  bot.on('polling_error',    err =>
    global.Reze?.log?.error(`[Web-HotBot @${me.username}] ${err.message}`)
  );

  const nextIndex = (global.Reze?.bots?.length || 0) + 1;
  global.Reze.bots.push({ bot, username: me.username, index: nextIndex, token });
  global.Reze?.log?.commands(`[Web] Hot-started @${me.username} as bot #${nextIndex}`);
  return { username: me.username, index: nextIndex };
}

async function hotStopBotFromWeb(token) {
  const idx = global.Reze?.bots?.findIndex(b => b.token === token) ?? -1;
  if (idx === -1) return null;     // wasn't running — not an error

  const { bot, username } = global.Reze.bots[idx];
  try {
    await bot.stopPolling();
    global.Reze.bots.splice(idx, 1);
    global.Reze?.log?.commands(`[Web] Hot-stopped @${username}`);
    return username;
  } catch (err) {
    // Force-remove from list even if stopPolling failed
    global.Reze.bots.splice(idx, 1);
    global.Reze?.log?.warn(`[Web] Force-removed @${username}: ${err.message}`);
    return username;
  }
}

// ── Token format validator ────────────────────────────────────────────────────
function isValidTokenFormat(token) {
  const parts = token.split(':');
  return parts.length === 2 && /^\d{5,}$/.test(parts[0]) && /^[A-Za-z0-9_-]{30,50}$/.test(parts[1]);
}

// ── Command/Event data from global.Reze ──────────────────────────────────────

function getCommandsData() {
  if (!global.Reze?.commands) return [];
  return [...global.Reze.commands.values()].map(cmd => {
    const m = cmd.meta || {};
    return {
      name:        m.name        || '',
      version:     m.version     || '1.0.0',
      aliases:     m.aliases     || [],
      description: m.description || '',
      category:    (m.category   || 'system').toLowerCase(),
      type:        (m.type       || 'anyone').toLowerCase(),
      guide:       m.guide       || [],
    };
  });
}

function getEventsData() {
  const files    = global.Reze?.eventCommandsFilesPath || [];
  const commands = global.Reze?.eventCommands || new Map();
  return files.map(({ filePath, commandName }) => {
    const mod = commands.get(commandName);
    const m   = mod?.meta || {};
    return {
      name:        m.name || commandName || '',
      version:     m.version || '1.0.0',
      author:      m.author || 'AjiroDesu',
      description: m.description || '',
      category:    (m.category || 'events').toLowerCase(),
      file:        path.basename(filePath || `${commandName}.js`),
      icon:        'event',
      color:       'green',
      trigger:     'Loaded from app/events',
      scope:       'app/events',
    };
  });
}

// ── Request Router ───────────────────────────────────────────────────────────

async function router(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── Static files ───────────────────────────────────────────────────────────
  if (url === '/' || url === '/index.html') {
    return serveFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  }

  // ── API ────────────────────────────────────────────────────────────────────

  // GET /api/status
  if (url === '/api/status' && method === 'GET') {
    const uptime   = global.Reze ? Date.now() - global.Reze.startTime : 0;
    const commands = getCommandsData();
    const bots     = global.Reze?.bots || [];
    const config   = global.Reze?.config || {};
    return json(res, {
      online:        true,
      uptime,
      startTime:     global.Reze?.startTime || Date.now(),
      commandCount:  commands.length,
      eventCount:    getEventsData().length,
      uptimeHistory: global.Reze?.uptimeHistory || [],
      botCount:      bots.length,
      bots:          bots.map(b => ({ username: b.username, index: b.index })),
      prefix:        config.prefix || '/',
      subprefix:     config.subprefix || [],
      timezone:      config.timezone || 'UTC',
      groqModel:     config.groqModel || 'llama-3.3-70b-versatile',
      developer:     config.developer || 'AjiroDesu',
      maintenance:   config.maintenance || false,
    });
  }

  // GET /api/commands
  if (url === '/api/commands' && method === 'GET') {
    return json(res, getCommandsData());
  }

  // GET /api/events
  if (url === '/api/events' && method === 'GET') {
    return json(res, getEventsData());
  }

  // GET /api/tokens — list tokens (masked) with live status
  if (url === '/api/tokens' && method === 'GET') {
    const tokens  = getTokensFromFile();
    const running = global.Reze?.bots || [];
    return json(res, tokens.map((t, i) => {
      const live = running.find(b => b.token === t);
      return {
        index:    i,
        masked:   t.split(':')[0] + ':' + '•'.repeat(14),
        live:     !!live,
        username: live ? live.username : null,
        botIndex: live ? live.index : null,
      };
    }));
  }

  // POST /api/tokens — add token + hot-start (no restart required)
  if (url === '/api/tokens' && method === 'POST') {
    const body  = await parseBody(req);
    const token = (body.token || '').trim();

    if (!token)
      return json(res, { ok: false, error: 'Token is empty.' }, 400);
    if (!isValidTokenFormat(token))
      return json(res, { ok: false, error: 'Invalid token format. Expected: <id>:<secret>' }, 400);

    const tokens = getTokensFromFile();
    if (tokens.includes(token))
      return json(res, { ok: false, error: 'Token already exists.' }, 409);

    // Hot-start BEFORE saving — if it fails the token is never written
    let botInfo;
    try {
      botInfo = await hotStartBotFromWeb(token);
    } catch (err) {
      return json(res, {
        ok:    false,
        error: `Hot-start failed: ${err.message}. Token was not saved.`,
      }, 500);
    }

    tokens.push(token);
    saveTokensToFile(tokens);

    return json(res, {
      ok:       true,
      message:  `Bot @${botInfo.username} is now online.`,
      username: botInfo.username,
      botIndex: botInfo.index,
      total:    tokens.length,
    });
  }

  // DELETE /api/tokens — remove token + hot-stop (no restart required)
  if (url === '/api/tokens' && method === 'DELETE') {
    const body  = await parseBody(req);
    const token = (body.token || '').trim();

    if (!token)
      return json(res, { ok: false, error: 'Token is empty.' }, 400);

    const tokens = getTokensFromFile();
    const idx    = tokens.indexOf(token);
    if (idx === -1)
      return json(res, { ok: false, error: 'Token not found in registry.' }, 404);

    // Stop the running instance (if any)
    const stoppedUsername = await hotStopBotFromWeb(token);

    tokens.splice(idx, 1);
    saveTokensToFile(tokens);

    return json(res, {
      ok:       true,
      message:  stoppedUsername
        ? `Bot @${stoppedUsername} has been stopped and removed.`
        : `Token removed (bot was not actively running).`,
      stopped:  !!stoppedUsername,
      username: stoppedUsername,
      remaining: tokens.length,
    });
  }

  res.writeHead(404);
  res.end('Not found');
}

// ── Start ────────────────────────────────────────────────────────────────────

export function startWebServer() {
  const server = http.createServer(router);
  server.listen(PORT, () => {
    if (global.Reze?.log) global.Reze.log.reze(`Dashboard running → http://localhost:${PORT}`);
    else console.log(`[Reze Dashboard] http://localhost:${PORT}`);
  });
  return server;
}
