import { Response } from './Response.js';

/*
 +----------------------------------------------------------+
 |                    HANDLER EVENT                         |
 |   Builds all handler functions for a given Telegram     |
 |   update. Mirrors GoatBot V2's handler pattern but      |
 |   adapted for node-telegram-bot-api (no database).      |
 +----------------------------------------------------------+
*/

// ─────────────────────────────────────────────────────────────────────────────
//   ROLE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRole(senderID) {
	const { devID = [], premium = [] } = global.Reze.config;
	const id = String(senderID);
	if (devID.includes(id))   return 2;   // developer
	if (premium.includes(id)) return 1;   // premium
	return 0;                             // anyone
}

async function isGroupAdmin(bot, chatId, senderID) {
	try {
		const member = await bot.getChatMember(chatId, senderID);
		return ['administrator', 'creator'].includes(member.status);
	} catch {
		return false;
	}
}

function getRoleConfig(command) {
	const typeMap = {
		developer: 2, premium: 1, anyone: 0,
		administrator: 0, admin: 0, private: 0, group: 0, hidden: 0,
	};
	const m = command.meta;
	if (typeof m?.role === 'number') {
		const base = m.role;
		return { onStart: base, onChat: base, onReply: base, onReaction: base, onCallback: base, onEvent: base };
	}
	if (typeof m?.role === 'object' && !Array.isArray(m?.role)) {
		const r   = m.role;
		const out = {};
		for (const k of ['onStart', 'onChat', 'onReply', 'onReaction', 'onCallback', 'onEvent'])
			out[k] = r[k] ?? r.onStart ?? 0;
		return out;
	}
	const base = typeMap[m?.type] ?? 0;
	return { onStart: base, onChat: base, onReply: base, onReaction: base, onCallback: base, onEvent: base };
}

// ─────────────────────────────────────────────────────────────────────────────
//   REACTION HELPER
//   🔥 = success  |  🤔 = failed
//   Reactions are sent via response.react() which calls bot.setMessageReaction
//   through Response.js — keeping all Telegram API calls in one place.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//   HANDLER EVENT FACTORY
// ─────────────────────────────────────────────────────────────────────────────

export default function createHandlerEvent(bot, groq) {
	return async function handleEvent(event) {
		const {
			commands, eventCommands,
			onReply:     onReplyMap,
			onReaction:  onReactionMap,
			onChat:      onChatList,
			onEvent:     onEventList,
			onAnyEvent:  onAnyEventList,
			onFirstChat: onFirstChatList,
			firstChatSeen, config,
		} = global.Reze;

		const allPrefixes = [config.prefix, ...(config.subprefix || [])];

		// ── Resolve core fields (GoatBot naming) ───────────────────────────────
		const msg      = event.message || event.edited_message || event.callback_query?.message || event;
		const chatId = msg?.chat?.id ?? event?.chat?.id;           
		if (!chatId) return;

		// ── Multi-bot conflict guard ──────────────────────────────────────────
		// When multiple bot instances from the same Reze system are present in
		// the same group chat, each one independently receives every message,
		// which would cause duplicate responses and spam.
		//
		// Resolution strategy:
		//   • The bot with the lowest `.index` in global.Reze.bots is elected
		//     the "primary" for ALL group chats on this system.
		//   • Every other bot (secondary) sends a single professional notice and
		//     immediately leaves that group chat, leaving only one bot active.
		//   • Private chats are never affected — every bot handles its own DMs.
		//   • If the primary is later removed, the next-lowest index takes over.
		//   • A per-bot per-chat eviction lock (gcEvictedChats) ensures the
		//     leave message is sent exactly once even if events race.
		const _chatType = msg?.chat?.type ?? event?.chat?.type ?? 'private';
		if (_chatType !== 'private') {
			const _bots = global.Reze?.bots ?? [];
			if (_bots.length > 1) {
				const _thisBotEntry = _bots.find(b => b.bot === bot);
				const _primaryIndex = Math.min(..._bots.map(b => b.index));

				if (_thisBotEntry && _thisBotEntry.index !== _primaryIndex) {
					// ── This is a secondary (redundant) bot ─────────────────────────
					const _evictKey = `${_thisBotEntry.index}:${chatId}`;
					const _evicted  = global.Reze.gcEvictedChats ?? (global.Reze.gcEvictedChats = new Set());

					if (!_evicted.has(_evictKey)) {
						// Lock immediately to prevent a second message if events race
						_evicted.add(_evictKey);

						const _primaryBot = _bots.find(b => b.index === _primaryIndex);
						const _primaryTag = _primaryBot?.username ? `@${_primaryBot.username}` : 'the primary instance';

						const _leaveMsg =
							`⚠️ *Multiple Bot Instances Detected*\n\n` +
							`This group currently has more than one bot from the same system running simultaneously. ` +
							`To prevent duplicate responses and ensure a clean, uninterrupted experience for all members, ` +
							`this redundant instance (*@${_thisBotEntry.username ?? 'this bot'}*) will now withdraw from the group.\n\n` +
							`${_primaryTag} will remain active and continue handling all commands and interactions as normal.\n\n` +
							`_Departing now — thank you for your patience._`;

						try {
							await bot.sendMessage(chatId, _leaveMsg, { parse_mode: 'Markdown' });
						} catch { /* best-effort — proceed to leave regardless */ }

						try {
							await bot.leaveChat(chatId);
							global.Reze?.log?.warn(
								`[Multi-Bot] @${_thisBotEntry.username} left group ${chatId} — ` +
								`yielding to primary @${_primaryBot?.username ?? _primaryIndex}`
							);
						} catch (e) {
							global.Reze?.log?.error(`[Multi-Bot] Failed to leave chat ${chatId}: ${e.message}`);
						}
					}

					return; // This bot is done — primary handles everything from here
				}
			}
		}
		// ── End multi-bot conflict guard ──────────────────────────────────────

		const from      = msg?.from || event?.from;
		const senderID  = String(from?.id ?? '');                    // GoatBot: senderID
		const messageID = msg?.message_id;                           // GoatBot: messageID
		const body      = msg?.text || msg?.caption || '';           // GoatBot: body
		const isGroup   = msg?.chat?.type !== 'private';             // GoatBot: isGroup
		const response  = new Response(bot, msg);
		const role      = getRole(senderID);

		// Expose body on the raw event object so commands can access event.body
		if (event.message)        event.message.body        = body;
		if (event.edited_message) event.edited_message.body = body;

		const api  = global.Reze.api;
		const base = {
			bot, groq, api, event: msg, body, response, role, config,
			senderID, chatId,
			messageID, isGroup, from,
		};

		// ── Usage guide factory ───────────────────────────────────────────────
		function createUsage(command) {
			return async function usage() {
				const m      = command.meta || {};
				const guides = Array.isArray(m.guide) ? m.guide : [m.guide || ''];
				let text = '▫️ **Usage Guide:**\n\n';
				for (const g of guides)
					text += g ? `\`${config.prefix}${m.name} ${g}\`\n` : `\`${config.prefix}${m.name}\`\n`;
				text += `\n📄 ${m.description || 'No description provided.'}`;
				await response.reply(text);
			};
		}

		/*
		 +------------------------------------------------+
		 |                  ON ANY EVENT                  |
		 +------------------------------------------------+
		*/
		async function onAnyEvent() {
			for (const name of (onAnyEventList || [])) {
				const cmd = commands.get(name);
				if (!cmd?.onAnyEvent) continue;
				try {
					const args = body ? body.split(/\s+/) : [];
					const fn   = await cmd.onAnyEvent({ ...base, args, commandName: name, usage: createUsage(cmd) });
					if (typeof fn === 'function') await fn();
				} catch (e) {
					console.error(`[onAnyEvent:${name}]`, e.message);
				}
			}
		}

		/*
		 +------------------------------------------------+
		 |                  ON FIRST CHAT                 |
		 +------------------------------------------------+
		*/
		async function onFirstChat() {
			for (const item of (onFirstChatList || [])) {
				const key = `${item.commandName}:${chatId}`;
				if (firstChatSeen.has(key)) continue;
				const cmd = commands.get(item.commandName);
				if (!cmd?.onFirstChat) continue;
				firstChatSeen.add(key);
				try {
					const args = body ? body.split(/\s+/) : [];
					const fn   = await cmd.onFirstChat({ ...base, args, commandName: item.commandName, usage: createUsage(cmd) });
					if (typeof fn === 'function') await fn();
				} catch (e) {
					console.error(`[onFirstChat:${item.commandName}]`, e.message);
				}
			}
		}

		/*
		 +------------------------------------------------+
		 |                    ON CHAT                     |
		 +------------------------------------------------+
		*/
		async function onChat() {
			let consumed = false;

			for (const name of (onChatList || [])) {
				const cmd = commands.get(name);
				if (!cmd?.onChat) continue;
				if (getRoleConfig(cmd).onChat > role) continue;
				try {
					const args = body ? body.split(/\s+/) : [];
					const fn   = await cmd.onChat({ ...base, args, commandName: name, usage: createUsage(cmd) });
					if (typeof fn === 'function') { await fn(); consumed = true; }
				} catch (e) {
					console.error(`[onChat:${name}]`, e.message);
				}
			}

			// ── Reze AI dispatcher ─────────────────────────────────────────────
			// Private: fires on every non-command message.
			// Group: only when "reze" is mentioned.
			// Skipped when: _fromReze flag is set (AI-injected), maintenance active for non-devs.
			if (!consumed && body && !event.message?._fromReze && !(global.Reze.config.maintenance && role < 2)) {
				const isCommand = allPrefixes.some(p => body.startsWith(p));
				const hasReply  = msg?.reply_to_message && onReplyMap.has(msg.reply_to_message.message_id);
				if (!isCommand && !hasReply && global.Reze.processWithReze)
					await global.Reze.processWithReze({ bot, chatId, senderID, from, body, response, event, isGroup });
			}
		}

		/*
		 +------------------------------------------------+
		 |             ON START (COMMAND CALL)            |
		 +------------------------------------------------+
		*/
		async function onStart() {
			if (!body) return;

			// ── Find used prefix ────────────────────────────────────────────────
			let usedPrefix = null;
			for (const p of allPrefixes) {
				if (body.startsWith(p)) { usedPrefix = p; break; }
			}
			if (!usedPrefix) return;

			const trimmed = body.slice(usedPrefix.length).trim();
			if (!trimmed) {
				await response.reply(`🟢 System Online.\nType ${usedPrefix}help to see commands.`);
				return;
			}

			// ── Resolve command ─────────────────────────────────────────────────
			const rawArgs   = trimmed.split(/\s+/);
			let commandName = rawArgs.shift().toLowerCase();

			// Handle /command@BotUsername syntax in groups
			const botUsername = global.Reze.botUsername;
			if (botUsername && commandName.includes('@')) {
				const [cmdPart, userPart] = commandName.split('@');
				if (userPart.toLowerCase() !== botUsername.toLowerCase()) return;
				commandName = cmdPart;
			}

			let cmd = commands.get(commandName);
			if (!cmd) {
				for (const [, c] of commands) {
					if (c.meta?.aliases?.includes(commandName)) { cmd = c; break; }
				}
			}

			if (!cmd) {
				if (!config.hideNotiMessage?.commandNotFound)
					await response.reply(`❌ The command "${commandName}" is not found in my system.`);
				return;
			}

			commandName     = cmd.meta.name;
			const rc        = getRoleConfig(cmd);
			const cmdType   = (cmd.meta?.type || 'anyone').toLowerCase();

			// ── Maintenance gate ────────────────────────────────────────────────
			if (global.Reze.config.maintenance && role < 2) {
				const ignored = global.Reze.config.maintenanceIgnore || [];
				if (!ignored.includes(commandName)) {
					await response.reply('🚧 **Bot is under maintenance.**\nPlease wait while the developer resolves the issue.');
					return;
				}
			}

			// ── Role check ──────────────────────────────────────────────────────
			if (rc.onStart > role) {
				if (!config.hideNotiMessage?.needRoleToUseCmd)
					await response.reply(rc.onStart === 2
						? `🔒 \`${commandName}\` is restricted to **developers**.`
						: `🔒 \`${commandName}\` is restricted to **premium** users.`);
				return;
			}

			// ── Context / type enforcement ──────────────────────────────────────
			if (cmdType === 'private' && isGroup) {
				if (!config.hideNotiMessage?.needRoleToUseCmd)
					await response.reply(`🔒 \`${commandName}\` can only be used in **private chat**.`);
				return;
			}
			if (cmdType === 'group' && !isGroup) {
				if (!config.hideNotiMessage?.needRoleToUseCmd)
					await response.reply(`🔒 \`${commandName}\` can only be used in **group chats**.`);
				return;
			}
			if (cmdType === 'administrator' || cmdType === 'admin') {
				if (role < 2) {
					if (!isGroup) {
						if (!config.hideNotiMessage?.needRoleToUseCmd)
							await response.reply(`🔒 \`${commandName}\` is restricted to **group administrators**.`);
						return;
					}
					const isChatAdmin = await isGroupAdmin(bot, chatId, senderID);
					if (!isChatAdmin) {
						if (!config.hideNotiMessage?.needRoleToUseCmd)
							await response.reply(`🔒 \`${commandName}\` is restricted to **group administrators**.`);
						return;
					}
				}
			}

			// ── Cooldown (bypassed for premium / developer) ────────────────────
			const coolKey  = `${commandName}:${senderID}`;
			const cooldown = (cmd.meta.cooldown ?? 1) * 1000;
			const now      = Date.now();

			if (role < 1) {
				const lastUsed = global.Reze.cooldowns.get(coolKey) ?? 0;
				if (now - lastUsed < cooldown) {
					const left = ((cooldown - (now - lastUsed)) / 1000).toFixed(1);
					await response.reply(`⏳ Please wait **${left}s** before using \`${commandName}\` again.`);
					return;
				}
			}

			if (typeof cmd.onStart !== 'function') return;

			// ── Execute ────────────────────────────────────────────────────────
			try {
				await cmd.onStart({ ...base, args: rawArgs, commandName, usedPrefix, usage: createUsage(cmd) });

				// ── 🔥 React — fires immediately on success ───────────────────
				await response.react('🔥');
				global.Reze.cooldowns.set(coolKey, now);
				global.Reze.log.commands(`${commandName} | ${from?.username ?? senderID} | ${chatId}`);
			} catch (e) {
				console.error(`[onStart:${commandName}]`, e);

				// ── 🤔 React — fires immediately on failure ───────────────────
				await response.react('🤔');
				await response.reply(`⚠️ Error in \`${commandName}\`:\n\`\`\`\n${e.message}\n\`\`\``);
			}
		}

		/*
		 +------------------------------------------------+
		 |                    ON REPLY                    |
		 +------------------------------------------------+
		*/
		async function onReply() {
			if (!msg?.reply_to_message) return;
			const replyToID = msg.reply_to_message.message_id;
			const data      = onReplyMap.get(replyToID);
			if (!data) return;
			const cmd = commands.get(data.commandName);
			if (!cmd?.onReply) return;
			if (getRoleConfig(cmd).onReply > role) return;

			try {
				const args = body ? body.split(/\s+/) : [];
				await cmd.onReply({
					...base, args,
					commandName: data.commandName,
					Reply:       { ...data, delete: () => onReplyMap.delete(replyToID) },
					usage:       createUsage(cmd),
				});

				// ── 🔥 React — fires immediately on success ───────────────────
				await response.react('🔥');
			} catch (e) {
				console.error(`[onReply:${data.commandName}]`, e.message);

				// ── 🤔 React — fires immediately on failure ───────────────────
				await response.react('🤔');
				await response.reply(`⚠️ Error in reply handler:\n\`\`\`\n${e.message}\n\`\`\``);
			}
		}

		/*
		 +------------------------------------------------+
		 |                   ON REACTION                  |
		 +------------------------------------------------+
		*/
		async function onReaction() {
			const data = onReactionMap.get(messageID);
			if (!data) return;
			const cmd = commands.get(data.commandName);
			if (!cmd?.onReaction) return;
			try {
				await cmd.onReaction({
					...base,
					commandName: data.commandName,
					Reaction:    { ...data, delete: () => onReactionMap.delete(messageID) },
					usage:       createUsage(cmd),
				});
			} catch (e) {
				console.error(`[onReaction:${data.commandName}]`, e.message);
			}
		}

		/*
		 +------------------------------------------------+
		 |                   ON CALLBACK                  |
		 +------------------------------------------------+
		*/
		async function onCallback() {
			const cbq = event.callback_query;
			if (!cbq) return;
			const rawData = cbq.data;
			if (!rawData) { await response.answerCallback(cbq, { text: 'Invalid callback.' }); return; }

			let payload;
			try { payload = JSON.parse(rawData); }
			catch {
				const parts = rawData.split(':');
				payload = parts.length ? { command: parts[0], args: parts.slice(1) } : null;
			}

			if (!payload?.command) { await response.answerCallback(cbq, { text: 'Invalid callback format.' }); return; }

			const cmd = commands.get(payload.command);
			if (!cmd?.onCallback) { await response.answerCallback(cbq, { text: 'Command not found.', show_alert: true }); return; }

			// Maintenance gate for callbacks
			const cbRole    = getRole(cbq.from?.id);
			const cbIgnored = global.Reze.config.maintenanceIgnore || [];
			if (global.Reze.config.maintenance && cbRole < 2 && !cbIgnored.includes(payload.command)) {
				await response.answerCallback(cbq, { text: '🚧 Bot is under maintenance.', show_alert: true });
				return;
			}

			if (getRoleConfig(cmd).onCallback > getRole(cbq.from?.id)) {
				await response.answerCallback(cbq, { text: 'Permission denied.', show_alert: true });
				return;
			}

			const cbMsg      = cbq.message || msg;
			const cbResponse = new Response(bot, cbMsg);

			try {
				await cmd.onCallback({
					bot, groq, api,
					callbackQuery: cbq,
					event:         cbq,
					response:      cbResponse,
					chatId:        cbMsg?.chat?.id,
					messageId:     cbMsg?.message_id,
					senderID:      String(cbq.from?.id ?? ''),
					from:          cbq.from,
					args:          payload.args || [],
					payload,
					role:          getRole(cbq.from?.id),
					config,
					usage:         createUsage(cmd),
				});
				await cbResponse.answerCallback(cbq).catch(() => {});
			} catch (e) {
				console.error(`[onCallback:${payload.command}]`, e.message);
				await cbResponse.answerCallback(cbq, { text: 'An error occurred. Please try again.', show_alert: true }).catch(() => {});
			}
		}

		/*
		 +------------------------------------------------+
		 |                    ON EVENT                    |
		 +------------------------------------------------+
		*/
		async function onEvent() {
			for (const name of (onEventList || [])) {
				const cmd = commands.get(name) || eventCommands.get(name);
				if (!cmd?.onEvent) continue;
				try {
					const fn = await cmd.onEvent({ ...base, commandName: name, args: [], usage: createUsage(cmd) });
					if (typeof fn === 'function') await fn();
				} catch (e) {
					console.error(`[onEvent:${name}]`, e.message);
				}
			}
		}

		return { onAnyEvent, onFirstChat, onChat, onStart, onReply, onReaction, onCallback, onEvent };
	};
}
