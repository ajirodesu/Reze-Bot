/**
 * Token Management Command
 * Hot-add or hot-remove bot tokens without restarting Reze.
 * Restricted to private chat / developers only.
 */
import fs            from 'fs-extra';
import path          from 'path';
import TelegramBot   from 'node-telegram-bot-api';
import Groq          from 'groq-sdk';
import { pathToFileURL } from 'url';

const TOKENS_PATH = path.resolve(process.cwd(), 'json', 'tokens.json');

export const meta = {
  name: 'token',
  version: '2.1.0',
  aliases: ['addtoken', 'tokens'],
  description: 'Add or remove a bot token (Hot Reload). Private chat only.',
  author: 'AjiroDesu',
  category: 'private',
  type: 'private',
  cooldown: 5,
  guide: ['add <token>', 'remove <token>', 'list'],
  prefix: 'both'
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function saveTokens(list) {
  await fs.writeFile(TOKENS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

/**
 * Hot-start a new bot instance and attach Reze's full handler pipeline.
 * FIX: handlerAction.js uses `export default` — must access via .default
 */
export async function hotStartBot(token) {
  const handlerActionMod = await import(
    pathToFileURL(path.resolve(process.cwd(), 'core', 'system', 'handlerAction.js')).href
  );
  // FIXED: was `{ createHandlerAction }` (named) but export is default
  const createHandlerAction = handlerActionMod.default;

  const groqKey = global.Reze?.config?.groqKey || global.Reze?.api?.groq || '';
  const groq    = groqKey ? new Groq({ apiKey: groqKey }) : null;

  const bot = new TelegramBot(token, { polling: true });
  const me  = await bot.getMe();

  const handlerAction = createHandlerAction(bot, groq);

  bot.on('message',          msg => handlerAction({ message: msg }));
  bot.on('edited_message',   msg => handlerAction({ edited_message: msg }));
  bot.on('callback_query',   cbq => handlerAction({ callback_query: cbq }));
  bot.on('message_reaction', rxn => handlerAction({ message_reaction: rxn }));
  bot.on('polling_error',    err =>
    global.Reze?.log?.error(`[Hot-Bot @${me.username}] ${err.message}`)
  );

  const nextIndex = (global.Reze?.bots?.length || 0) + 1;
  global.Reze.bots.push({ bot, username: me.username, index: nextIndex, token });
  global.Reze?.log?.commands(`Hot-started @${me.username} as bot #${nextIndex}`);
  return me.username;
}

/**
 * Hot-stop a bot instance by token.
 */
export async function hotStopBot(token) {
  const idx = global.Reze?.bots?.findIndex(b => b.token === token) ?? -1;
  if (idx === -1) return false;

  const { bot, username } = global.Reze.bots[idx];
  try {
    await bot.stopPolling();
    global.Reze.bots.splice(idx, 1);
    global.Reze?.log?.commands(`Hot-stopped @${username}`);
    return true;
  } catch {
    return false;
  }
}

// Telegram token: <digits>:<35-char alphanum secret>
function isValidToken(token) {
  return /^\d{5,}:[A-Za-z0-9_-]{30,50}$/.test(token);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function onStart({ bot, event, args, response, usage }) {
  if (!args.length) return usage();

  const action = args[0].toLowerCase();

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const current = await fs.readJson(TOKENS_PATH).catch(() => []);
    const running = global.Reze?.bots || [];

    if (!current.length) return response.reply('📭 **No tokens saved.**');

    const lines = current.map((t, i) => {
      const id     = t.split(':')[0];
      const masked = `${id}:${'•'.repeat(14)}`;
      const live   = running.find(b => b.token === t);
      const status = live ? `✅ @${live.username}` : '⭕ not running';
      return `**#${i + 1}** \`${masked}\` — ${status}`;
    });

    return response.reply(`🔑 **Saved Tokens** (${current.length})\n\n${lines.join('\n')}`);
  }

  if (args.length < 2) return usage();
  const token = args[1].trim();

  if (!isValidToken(token)) {
    return response.reply(
      '⚠️ **Invalid Format**\n' +
      'Provide a valid Telegram bot token (`ID:Secret`).\n' +
      'Example: `1234567890:ABCDefGHij...`'
    );
  }

  const loading = await response.reply('⚙️ **Processing token...**');

  try {
    const current = await fs.readJson(TOKENS_PATH).catch(() => []);

    // ── ADD ───────────────────────────────────────────────────────────────
    if (action === 'add') {
      if (current.includes(token)) {
        return response.edit('text', loading, '♻️ **Already Exists**\nThis token is already saved and running.');
      }

      let username;
      try {
        username = await hotStartBot(token);
      } catch (err) {
        return response.edit(
          'text', loading,
          `❌ **Hot-Start Failed**\n\`${err.message}\`\n\nToken was **not** saved.`
        );
      }

      current.push(token);
      await saveTokens(current);

      return response.edit(
        'text', loading,
        `✅ **Token Added & Started**\n\n` +
        `Bot **@${username}** is now online.\n` +
        `🆔 \`${token.split(':')[0]}:${'•'.repeat(14)}\`\n` +
        `📦 Total bots: **${current.length}**`
      );
    }

    // ── REMOVE ────────────────────────────────────────────────────────────
    if (action === 'remove' || action === 'delete') {
      if (!current.includes(token)) {
        return response.edit('text', loading, '⚠️ **Not Found**\nThis token is not in the saved list.');
      }

      const stopped = await hotStopBot(token);
      await saveTokens(current.filter(t => t !== token));

      return response.edit(
        'text', loading,
        stopped
          ? `🗑️ **Token Removed & Stopped**\n\nBot instance terminated.\n📦 Remaining: **${current.length - 1}**`
          : `🗑️ **Token Removed**\n\nRemoved from file (was not actively running).\n📦 Remaining: **${current.length - 1}**`
      );
    }

    return response.edit('text', loading, '❌ **Unknown Action**\nUse `add`, `remove`, or `list`.');

  } catch (err) {
    console.error('[Token Cmd]', err);
    await response.edit('text', loading, `⚠️ **System Error**\n\`${err.message}\``);
  }
}
