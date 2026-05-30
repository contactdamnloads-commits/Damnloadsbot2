require('dotenv').config();

const { 
    Client, GatewayIntentBits, ActivityType, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, Events, PermissionsBitField, EmbedBuilder,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType
} = require('discord.js');
const ms = require('ms');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

// ─── GESTION D'ERREURS GLOBALE ───────────────────────────────────────────────
// Évite que le bot crash sur un rate limit ou une promesse non gérée
process.on('unhandledRejection', (err) => {
    console.error('[Bot] Erreur non gérée (le bot continue) :', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('[Bot] Exception non capturée (le bot continue) :', err?.message || err);
});

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, // Indispensable pour la Bio
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences // Indispensable pour le Statut
    ] 
});

const TOKEN     = process.env.DISCORD_TOKEN;
const SERVER_ID = process.env.DISCORD_GUILD_ID || '1475143431289569451';
const SITE_CHANNEL_ID = '1475143432879083633';
const PREFIX = '!';

// ─── Validation des variables d'environnement ────────────────────────────────
if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL manquant dans les variables d\'environnement');
if (!process.env.SUPABASE_KEY) throw new Error('SUPABASE_KEY manquant dans les variables d\'environnement');
if (!TOKEN)                    throw new Error('DISCORD_TOKEN manquant dans les variables d\'environnement');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const SITE_URL = 'https://damnloads.com';

// ─── IDs PRIVILÉGIÉS ─────────────────────────────────────────────────────────
const PRIVILEGED_IDS = new Set([
    '1475147452540653578',  // Co-Fondateur
    '1491776456299118745',  // Fondateur
    '1475149005611733083',  // Admin
]);
const MEMBRE_ROLE_ID = '1475145154695397467';
const GIVEAWAY_EMOJI = '🎉';
const GIVEAWAY_FILE = './giveaways.json';

// ─── PERSISTANCE SUPABASE ────────────────────────────────────────────────────
// Tables requises (à créer une seule fois dans Supabase) :
//
//  CREATE TABLE bot_config (
//      key   TEXT PRIMARY KEY,
//      value JSONB NOT NULL
//  );
//
// Cette unique table stocke tout : config, warns, tempbans, state.
// Chaque "clé" est une entrée : 'config', 'warns', 'tempbans', 'state'

async function dbGet(key, fallback = null) {
    try {
        const { data, error } = await supabase
            .from('bot_config')
            .select('value')
            .eq('key', key)
            .single();
        if (error || !data) return fallback;
        return data.value;
    } catch (e) {
        console.error(`[DB] Erreur lecture '${key}':`, e.message);
        return fallback;
    }
}

async function dbSet(key, value) {
    try {
        const { error } = await supabase
            .from('bot_config')
            .upsert({ key, value }, { onConflict: 'key' });
        if (error) console.error(`[DB] Erreur sauvegarde '${key}':`, error.message);
    } catch (e) {
        console.error(`[DB] Erreur sauvegarde '${key}':`, e.message);
    }
}

// Wrappers spécialisés
async function loadConfig() {
    const data = await dbGet('config');
    return data ?? {
        logChannel: null, welcomeChannel: null,
        welcomeMessage: 'Bienvenue sur le serveur, {user} ! 🎉',
        autoRole: null, modRole: null, mutedRole: null,
        antiSpam: false, antiSpamThreshold: 5, antiSpamInterval: 3,
        giveawayChannel: null, gameNotifChannel: null, prefix: '!',
    };
}
async function saveConfig(cfg)    { await dbSet('config', cfg); }

async function loadWarnsDB() {
    const data = await dbGet('warns', {});
    return new Map(Object.entries(data));
}
async function saveWarns(w)       { await dbSet('warns', Object.fromEntries(w)); }

async function loadTempbans()     { return await dbGet('tempbans', {}); }
async function saveTempbans(tb)   { await dbSet('tempbans', tb); }

async function loadState()        { return await dbGet('state', { raidMode: false }); }
async function saveState(s)       { await dbSet('state', s); }

// Chargement synchrone remplacé par init async (appelé dans ready)
let botConfig = {
    logChannel: null, welcomeChannel: null,
    welcomeMessage: 'Bienvenue sur le serveur, {user} ! 🎉',
    autoRole: null, modRole: null, mutedRole: null,
    antiSpam: false, antiSpamThreshold: 5, antiSpamInterval: 3,
    giveawayChannel: null, gameNotifChannel: null, prefix: '!',
};
const warns    = new Map();
let tempbans   = {};
let raidMode   = false;

// ─── CONFIG SERVEUR (persistée dans config.json) ──────────────────────────────
// (config, warns, tempbans, state sont maintenant chargés depuis Supabase dans ready())

require('./role-sync')(client);
require('./recent-games')(client, supabase);
require('./new-game-notifier')(client, supabase, () => botConfig.gameNotifChannel);

// ─── PERSISTANCE JSON ───────────────────────────────────────────────────────

function loadGiveaways() {
    if (!fs.existsSync(GIVEAWAY_FILE)) return new Map();
    try {
        const raw = fs.readFileSync(GIVEAWAY_FILE, 'utf8');
        return new Map(Object.entries(JSON.parse(raw)));
    } catch { return new Map(); }
}

function saveGiveaways() {
    fs.writeFileSync(GIVEAWAY_FILE, JSON.stringify(Object.fromEntries(giveaways), null, 2), 'utf8');
}

const giveaways = loadGiveaways();



// ─── HELPERS GIVEAWAY ───────────────────────────────────────────────────────

async function pickWinners(message, winnersCount) {
    const reaction = message.reactions.cache.get(GIVEAWAY_EMOJI);
    if (!reaction) return [];
    const users = await reaction.users.fetch();
    const pool = users.filter(u => !u.bot).map(u => u);
    if (pool.length === 0) return [];
    const winners = [];
    const count = Math.min(winnersCount, pool.length);
    for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        winners.push(pool.splice(idx, 1)[0]);
    }
    return winners;
}

function buildGiveawayEmbed(prize, winnersCount, endTime, hostId, participantsCount = 0) {
    const remaining = Math.max(0, endTime - Date.now());
    const endTimestamp = Math.floor(endTime / 1000);
    return new EmbedBuilder()
        .setTitle(`🎉 GIVEAWAY — ${prize}`)
        .setDescription(
            `Réagis avec ${GIVEAWAY_EMOJI} pour participer !\n\n` +
            `**Gagnants :** ${winnersCount}\n` +
            `**Fin :** <t:${endTimestamp}:R> (<t:${endTimestamp}:f>)\n` +
            `**Organisé par :** <@${hostId}>\n` +
            `**Participants :** ${participantsCount}`
        )
        .setColor('#FFD700')
        .setFooter({ text: `Se termine dans : ${ms(remaining, { long: true })} • Réagis avec ${GIVEAWAY_EMOJI}` })
        .setTimestamp(endTime);
}

function buildEndedEmbed(prize, winners, hostId) {
    const winnersText = winners.length > 0 ? winners.map(w => `<@${w.id}>`).join(', ') : 'Aucun participant 😢';
    return new EmbedBuilder()
        .setTitle(`🎊 GIVEAWAY TERMINÉ — ${prize}`)
        .setDescription(`**Gagnant(s) :** ${winnersText}\n**Prix :** ${prize}\n**Organisé par :** <@${hostId}>`)
        .setColor('#FF4444')
        .setFooter({ text: 'Giveaway terminé' })
        .setTimestamp();
}

async function endGiveaway(messageId) {
    const gw = giveaways.get(messageId);
    if (!gw || gw.ended) return;
    gw.ended = true;
    giveaways.set(messageId, gw);
    saveGiveaways(); // persiste l'état terminé
    try {
        const channel = await client.channels.fetch(gw.channelId);
        const message = await channel.messages.fetch(messageId);
        const winners = await pickWinners(message, gw.winnersCount);
        await message.edit({ embeds: [buildEndedEmbed(gw.prize, winners, gw.hostId)] });
        if (winners.length > 0) {
            const winnersText = winners.map(w => `<@${w.id}>`).join(', ');
            await channel.send(`🎊 Félicitations ${winnersText} ! Vous avez gagné **${gw.prize}** ! Contactez <@${gw.hostId}> pour réclamer votre prix.`);
        } else {
            await channel.send(`😔 Pas assez de participants pour le giveaway **${gw.prize}**. Personne n'a gagné.`);
        }
    } catch (e) {
        console.error(`Erreur fin giveaway ${messageId}:`, e);
    }
}

// Planifie ou exécute immédiatement la fin d'un giveaway (utilisé au redémarrage)
function scheduleGiveaway(messageId) {
    const gw = giveaways.get(messageId);
    if (!gw || gw.ended) return;
    const delay = gw.endTime - Date.now();
    if (delay <= 0) {
        console.log(`⚠️  Giveaway expiré pendant l'arrêt, terminaison immédiate : ${messageId}`);
        endGiveaway(messageId);
    } else {
        setTimeout(() => endGiveaway(messageId), delay);
        console.log(`⏰ Giveaway restauré : "${gw.prize}" — se termine dans ${ms(delay, { long: true })}`);
    }
}

// ─── READY ──────────────────────────────────────────────────────────────────

client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} est prêt !`);

    // ── Chargement depuis Supabase ──────────────────────────────────────────────
    try {
        const [cfgData, warnsData, tempbansData, stateData] = await Promise.all([
            loadConfig(),
            loadWarnsDB(),
            loadTempbans(),
            loadState(),
        ]);
        Object.assign(botConfig, cfgData);
        for (const [k, v] of warnsData) warns.set(k, v);
        Object.assign(tempbans, tempbansData);
        raidMode = stateData.raidMode ?? false;
        console.log(`💾 Supabase chargé | RaidMode: ${raidMode} | Warns: ${warns.size} users | Tempbans: ${Object.keys(tempbans).length}`);
    } catch (e) {
        console.error('[Boot] Erreur chargement Supabase:', e.message);
    }

    // ── Restaure les giveaways actifs ──────────────────────────────────────────
    let restored = 0;
    for (const [messageId, gw] of giveaways) {
        if (!gw.ended) { scheduleGiveaway(messageId); restored++; }
    }
    if (restored > 0) console.log(`🔄 ${restored} giveaway(s) restauré(s).`);

    // ── Restaure les tempbans en attente ────────────────────────────────────
    const now = Date.now();
    let tbRestored = 0;
    for (const [userId, tb] of Object.entries(tempbans)) {
        const remaining = tb.unbanAt - now;
        const guild = client.guilds.cache.get(tb.guildId);
        if (!guild) continue;
        if (remaining <= 0) {
            // Déjà expiré pendant le downtime → unban immédiat
            guild.members.unban(userId, 'Tempban expiré (rattrapage boot)').catch(() => {});
            delete tempbans[userId];
        } else {
            // Pas encore expiré → replanifier
            setTimeout(async () => {
                await guild.members.unban(userId, 'Tempban expiré').catch(() => {});
                delete tempbans[userId];
                saveTempbans(tempbans);
            }, remaining);
            tbRestored++;
        }
    }
    saveTempbans(tempbans);
    if (tbRestored > 0) console.log(`⏳ ${tbRestored} tempban(s) restauré(s).`);

    // ── Résumé persistance ──────────────────────────────────────────────────
    console.log(`💾 Config chargée | RaidMode: ${raidMode} | Warns: ${warns.size} users | Tempbans actifs: ${tbRestored}`);

    // ── Un seul fetch des membres, partagé par toutes les syncs ──────────────
    const guild = client.guilds.cache.get(SERVER_ID);
    if (guild) {
        try {
            console.log("[Boot] Chargement des membres en cache...");
            await guild.members.fetch();
            console.log(`[Boot] ${guild.memberCount} membres chargés.`);
        } catch (e) {
            console.error("[Boot] Erreur lors du fetch des membres :", e.message);
        }
    }

    // Sync des boosters au démarrage (utilise le cache déjà chargé)
    await syncAllBoosters();

    // Scan du rôle Soutien au démarrage (utilise le cache déjà chargé)
    await syncAllSoutienRoles();

    const updateStatus = () => {
        const guild = client.guilds.cache.get(SERVER_ID);
        if (guild) {
            client.user.setPresence({
                activities: [{ name: `DamnLoads | ${guild.memberCount} membres`, type: ActivityType.Watching }],
                status: 'online',
            });
        }
    };
    updateStatus();
    setInterval(updateStatus, 600000);
});



// ─── ANTI-RAID ───────────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async member => {
    // Anti-raid
    if (raidMode) return member.kick('Raidmode actif').catch(console.error);

    // Auto-rôle
    if (botConfig.autoRole) {
        const role = member.guild.roles.cache.get(botConfig.autoRole);
        if (role) member.roles.add(role).catch(e => console.error('[AutoRole]', e.message));
    }

    // Message de bienvenue
    if (botConfig.welcomeChannel) {
        const channel = member.guild.channels.cache.get(botConfig.welcomeChannel);
        if (channel) {
            const msg = botConfig.welcomeMessage.replace('{user}', `<@${member.id}>`);
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('👋 Nouveau membre !')
                .setDescription(msg)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '📅 Compte créé le', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:D>`, inline: true },
                    { name: '👥 Membre n°', value: `${member.guild.memberCount}`, inline: true },
                )
                .setTimestamp();
            channel.send({ embeds: [embed] }).catch(e => console.error('[Welcome]', e.message));
        } else {
            console.warn('[Welcome] Canal introuvable :', botConfig.welcomeChannel);
        }
    }

    // Log
    if (botConfig.logChannel) {
        const logChan = member.guild.channels.cache.get(botConfig.logChannel);
        if (logChan) {
            logChan.send({ embeds: [new EmbedBuilder()
                .setColor('#57F287')
                .setTitle('📥 Membre rejoint')
                .setDescription(`<@${member.id}> (**${member.user.tag}**)`)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields({ name: 'ID', value: member.id, inline: true })
                .setTimestamp()
            ]}).catch(() => {});
        }
    }
});

// ─── MEMBRE QUITTE ───────────────────────────────────────────────────────────

client.on(Events.GuildMemberRemove, async member => {
    if (!botConfig.logChannel) return;
    const logChan = member.guild.channels.cache.get(botConfig.logChannel);
    if (!logChan) return;

    // Récupère les rôles (hors @everyone)
    const roles = member.roles.cache
        .filter(r => r.id !== member.guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => `<@&${r.id}>`);
    const rolesDisplay = roles.length ? roles.slice(0, 10).join(' ') : '`Aucun`';

    // Cherche si c'est un kick ou un ban récent via l'audit log
    let reason = null;
    let action = '📤 Membre parti';
    let actionColor = '#ED4245'; // rouge
    try {
        await new Promise(r => setTimeout(r, 1000)); // petit délai pour que l'audit log soit dispo
        const auditLogs = await member.guild.fetchAuditLogs({ limit: 5, type: 20 }); // 20 = MEMBER_KICK
        const kickEntry = auditLogs.entries.find(e =>
            e.target.id === member.id && (Date.now() - e.createdTimestamp) < 5000
        );
        if (kickEntry) {
            action = '👢 Membre expulsé (kick)';
            actionColor = '#FFA500';
            reason = kickEntry.reason || 'Aucune raison';
        }
    } catch {}

    try {
        const auditLogs = await member.guild.fetchAuditLogs({ limit: 5, type: 22 }); // 22 = MEMBER_BAN_ADD
        const banEntry = auditLogs.entries.find(e =>
            e.target.id === member.id && (Date.now() - e.createdTimestamp) < 5000
        );
        if (banEntry) {
            action = '🔨 Membre banni';
            actionColor = '#ED4245';
            reason = banEntry.reason || 'Aucune raison';
        }
    } catch {}

    const embed = new EmbedBuilder()
        .setColor(actionColor)
        .setTitle(action)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .addFields(
            { name: '👤 Utilisateur',   value: `<@${member.id}> (${member.user.tag})`,                              inline: false },
            { name: '🪪 ID',            value: `\`${member.id}\``,                                                   inline: true  },
            { name: '📅 Avait rejoint', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Inconnu', inline: true },
            { name: `🎭 Rôles (${roles.length})`, value: rolesDisplay,                                               inline: false },
        );

    if (reason) embed.addFields({ name: '📋 Raison', value: reason, inline: false });

    embed.setTimestamp().setFooter({ text: `Membres restants : ${member.guild.memberCount}` });

    logChan.send({ embeds: [embed] }).catch(e => console.error('[Leave Log]', e.message));
});

// ─── SERVER BOOSTER ──────────────────────────────────────────────────────────

async function setBoosterStatus(discordId, isBooster) {
    const { error } = await supabase
        .from('profiles')
        .update({ is_booster: isBooster })
        .eq('discord_id', discordId);
    if (error) console.error('[DL] Erreur setBoosterStatus:', error.message);
}

// Sync complète au démarrage : remet tout le monde à jour (utilise le cache)
async function syncAllBoosters() {
    const guild = client.guilds.cache.get(SERVER_ID);
    if (!guild) return;

    const boosterRole = guild.roles.cache.find(r => r.tags?.premiumSubscriberRole);
    if (!boosterRole) {
        console.log('[DL] ⚠️ Rôle Booster introuvable sur le serveur');
        return;
    }

    const boosterIds  = guild.members.cache
        .filter(m => m.roles.cache.has(boosterRole.id))
        .map(m => m.id);

    // Remet tout le monde à false, puis passe les boosters actifs à true
    await supabase.from('profiles').update({ is_booster: false }).neq('discord_id', '0');
    for (const id of boosterIds) {
        await setBoosterStatus(id, true);
    }
    console.log(`[DL] 💜 Sync boosters : ${boosterIds.length} booster(s) mis à jour`);
}



// ─── MESSAGES ───────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;

    if (message.content.toLowerCase() === 'site' || message.content.toLowerCase() === '!site') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🌐 Accéder au site').setURL(SITE_URL).setStyle(ButtonStyle.Link)
        );
        return message.reply({ content: "Voici l'accès au site Damnloads :", components: [row] });
    }

    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const isMod = message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers);
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

    try {
        switch (command) {

            case 'help': {
                const isPrivileged = PRIVILEGED_IDS.has(message.author.id);
                const isMembre = message.member.roles.cache.has(MEMBRE_ROLE_ID);

                const siteButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel('🌐 Accéder au site').setURL(SITE_URL).setStyle(ButtonStyle.Link)
                );

                if (isPrivileged || isAdmin) {
                    return message.reply({ embeds: [new EmbedBuilder()
                        .setTitle('📚 Commandes — Staff')
                        .setColor('#FFD700')
                        .setThumbnail(client.user.displayAvatarURL())
                        .addFields(
                            { name: '🛠️ Modération', value: [
                                '`!kick @user [raison]` — Expulser un membre',
                                '`!ban @user [raison]` — Bannir *(Admin)*',
                                '`!tempban @user <durée> [raison]` — Bannir temporairement *(Admin)*',
                                '`!timeout @user <durée>` — Mettre en sourdine (ex: `10m`)',
                                '`!untimeout @user` — Retirer la sourdine',
                                '`!warn @user [raison]` — Avertir un membre',
                                '`!clear <1-100>` — Supprimer des messages',
                            ].join('\n') },
                            { name: '🛡️ Sécurité', value: [
                                '`!lock` — Verrouiller le salon',
                                '`!unlock` — Déverrouiller le salon',
                                '`!raidmode` — Activer/désactiver le mode anti-raid *(Admin)*',
                            ].join('\n') },
                            { name: '⚙️ Configuration', value: '`!slowmode <secondes>` — Définir le slowmode du salon' },
                            { name: '🔍 Informations', value: [
                                '`!dlinfo [@user]` — Profil Damnloads d\'un membre',
                                '`!id @user` — ID Discord d\'un membre',
                            ].join('\n') },
                            { name: '🎉 Giveaway', value: [
                                '`!giveaway start <durée> <gagnants> <prix>` — Lancer',
                                '`!giveaway end <messageId>` — Terminer',
                                '`!giveaway reroll <messageId>` — Retirer au sort',
                                '`!giveaway list` — Voir les giveaways actifs',
                                '*(alias : `!gw`)*',
                            ].join('\n') },
                            { name: '🌐 Autres', value: '`site` ou `!site` — Accès au site\n`!help` — Afficher cette aide' },
                        )
                        .setFooter({ text: 'Staff uniquement • damnloads.com' })
                    ], components: [siteButton] });
                }

                if (isMembre || isMod) {
                    return message.reply({ embeds: [new EmbedBuilder()
                        .setTitle('📚 Commandes')
                        .setColor('#5865F2')
                        .setThumbnail(client.user.displayAvatarURL())
                        .addFields(
                            { name: '🔍 Informations', value: [
                                '`!dlinfo [@user]` — Voir ton profil Damnloads (ou celui d\'un membre)',
                                '`!id @user` — Afficher l\'ID Discord d\'un membre',
                            ].join('\n') },
                            { name: '🌐 Site', value: '`site` ou `!site` — Accès au site Damnloads\n`!help` — Afficher cette aide' },
                        )
                        .setFooter({ text: 'damnloads.com' })
                    ], components: [siteButton] });
                }

                return message.reply({ embeds: [new EmbedBuilder()
                    .setTitle('📚 Commandes')
                    .setColor('#2f3136')
                    .setThumbnail(client.user.displayAvatarURL())
                    .addFields(
                        { name: '🌐 Site', value: '`site` ou `!site` — Accès au site Damnloads\n`!help` — Afficher cette aide' },
                    )
                    .setFooter({ text: 'damnloads.com' })
                ], components: [siteButton] });
            }
            case 'clear': {
                if (!isMod) return;
                const amount = parseInt(args[0]);
                if (isNaN(amount) || amount < 1 || amount > 100) return message.reply("Nombre entre 1 et 100.");
                await message.channel.bulkDelete(amount, true);
                message.channel.send(`🧹 **${amount}** messages supprimés.`).then(m => setTimeout(() => m.delete(), 3000));
                break;
            }

            case 'kick': {
                if (!isMod) return;
                const kickMem = message.mentions.members.first();
                if (!kickMem || !kickMem.kickable) return message.reply("Utilisateur introuvable ou trop haut gradé.");
                await kickMem.kick(args.slice(1).join(" ") || "Aucune raison");
                message.reply(`✅ **${kickMem.user.tag}** expulsé.`);
                break;
            }

            case 'ban': {
                if (!isAdmin) return;
                const banMem = message.mentions.members.first();
                if (!banMem || !banMem.bannable) return message.reply("Impossible de bannir.");
                await banMem.ban({ reason: args.slice(1).join(" ") || "Aucune raison" });
                message.reply(`🚫 **${banMem.user.tag}** banni.`);
                break;
            }

            case 'tempban': {
                if (!isAdmin) return;
                const tbMem = message.mentions.members.first();
                const time = args[1];
                if (!tbMem || !time) return message.reply("Usage: !tempban @user 1h");
                const tbReason = args.slice(2).join(' ') || 'Aucune raison';
                const tbDuration = ms(time);
                if (!tbDuration) return message.reply('❌ Durée invalide. Exemple : `1h`, `30m`, `2d`');
                await tbMem.ban({ reason: `Tempban (${time}): ${tbReason}` });
                const tbUnbanAt = Date.now() + tbDuration;
                tempbans[tbMem.id] = { guildId: message.guild.id, unbanAt: tbUnbanAt, reason: tbReason };
                saveTempbans(tempbans);
                message.reply(`⏳ **${tbMem.user.tag}** banni pour **${time}**.`);
                setTimeout(async () => {
                    await message.guild.members.unban(tbMem.id, 'Tempban expiré').catch(() => {});
                    delete tempbans[tbMem.id];
                    saveTempbans(tempbans);
                }, tbDuration);
                break;
            }

            case 'timeout': {
                if (!isMod) return;
                const toMem = message.mentions.members.first();
                const dur = args[1];
                if (!toMem || !dur) return message.reply("Usage: !timeout @user 10m");
                await toMem.timeout(ms(dur), args.slice(2).join(" "));
                message.reply(`🔇 **${toMem.user.tag}** muté.`);
                break;
            }

            case 'untimeout': {
                if (!isMod) return;
                const utoMem = message.mentions.members.first();
                if (utoMem) { await utoMem.timeout(null); message.reply("🔊 Micro rendu."); }
                break;
            }

            case 'warn': {
                if (!isMod) return;
                const wUser = message.mentions.users.first();
                if (!wUser) return message.reply("Mentionne l'utilisateur.");
                if (!warns.has(wUser.id)) warns.set(wUser.id, []);
                warns.get(wUser.id).push({ reason: args.slice(1).join(' ') || 'Raison non spécifiée', date: new Date().toISOString(), by: message.author.tag });
                saveWarns(warns);
                message.reply(`⚠️ **${wUser.tag}** a été warn. (Total: ${warns.get(wUser.id).length})`);
                break;
            }

            case 'warns': {
                if (!isMod) return;
                const wTarget = message.mentions.users.first();
                if (!wTarget) return message.reply('⚠️ Mentionne un utilisateur. Ex: `!warns @user`');
                const userWarns = warns.get(wTarget.id) ?? [];
                if (!userWarns.length) return message.reply(`✅ **${wTarget.tag}** n\'a aucun warn.`);
                const list = userWarns.map((w, i) => {
                    const reason = typeof w === 'string' ? w : w.reason;
                    const by     = typeof w === 'string' ? '?' : w.by;
                    const date   = typeof w === 'string' ? '' : ` — <t:${Math.floor(new Date(w.date).getTime()/1000)}:d>`;
                    return `**${i+1}.** ${reason} *(par ${by}${date})*`;
                }).join('\n');
                const warnEmbed = new EmbedBuilder()
                    .setTitle(`⚠️ Warns de ${wTarget.tag}`)
                    .setColor('#FFA500')
                    .setDescription(list)
                    .setFooter({ text: `Total : ${userWarns.length} warn(s)` })
                    .setThumbnail(wTarget.displayAvatarURL());
                message.channel.send({ embeds: [warnEmbed] });
                break;
            }

            case 'clearwarns': {
                if (!isAdmin) return;
                const cwTarget = message.mentions.users.first();
                if (!cwTarget) return message.reply('⚠️ Mentionne un utilisateur.');
                warns.delete(cwTarget.id);
                saveWarns(warns);
                message.reply(`✅ Warns de **${cwTarget.tag}** effacés.`);
                break;
            }

            case 'raidmode': {
                if (!isAdmin) return;
                raidMode = !raidMode;
                saveState({ raidMode });
                message.reply(raidMode ? '🚨 **RAIDMODE ACTIVÉ**' : '✅ **RAIDMODE DÉSACTIVÉ**');
                break;
            }

            case 'lock': {
                if (!isMod) return;
                await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
                message.reply("🔒 Salon verrouillé.");
                break;
            }

            case 'unlock': {
                if (!isMod) return;
                await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
                message.reply("🔓 Salon déverrouillé.");
                break;
            }

            case 'slowmode': {
                if (!isMod) return;
                const sec = args[0];
                if (isNaN(sec)) return message.reply("Donne un nombre de secondes.");
                await message.channel.setRateLimitPerUser(parseInt(sec));
                message.reply(`🐌 Slowmode : **${sec}s**.`);
                break;
            }

            case 'dlinfo': {
                const target = message.mentions.users.first() || message.author;

                // 1. Récupération du profil depuis Supabase
                const { data: profile, error: profileError } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('discord_id', target.id)
                    .single();

                if (profileError || !profile) {
                    return message.reply(`❌ Aucun compte trouvé pour **${target.username}**.`);
                }

                // 2. Récupération des badges
                let badgeDisplay = 'Aucun badge';

                if (profile.visible_badges && Array.isArray(profile.visible_badges) && profile.visible_badges.length > 0) {
                    const cleanIds = profile.visible_badges.map(id => String(id).trim());

                    const { data: codes, error: codeError } = await supabase
                        .from('promo_codes')
                        .select('code')
                        .in('id', cleanIds);

                    if (!codeError && codes && codes.length > 0) {
                        badgeDisplay = codes.map(c => `• ${c.code}`).join('\n');
                    } else {
                        const { data: codesAlt } = await supabase
                            .from('promo_codes')
                            .select('code')
                            .in('badge_id', cleanIds);

                        badgeDisplay = (codesAlt?.length > 0)
                            ? codesAlt.map(c => `• ${c.code}`).join('\n')
                            : '⚠️ Badge non trouvé dans la boutique.';
                    }
                }

                // 3. Formatage de la date d'inscription en timestamp Discord
                const createdAtUnix = profile.created_at
                    ? Math.floor(new Date(profile.created_at).getTime() / 1000)
                    : null;

                // 4. Titre avec indicateur booster
                const titleName = profile.is_booster
                    ? `${profile.username} 💜`
                    : profile.username;

                // 5. Couleur selon statut : banni = rouge, booster = violet, normal = bleu Discord
                const embedColor = profile.is_banned
                    ? '#ff4444'
                    : profile.is_booster
                        ? '#f47fff'
                        : '#5865F2';

                // 6. Construction de l'embed
                const profileUrl = `https://www.damnloads.com/profile.html?id=${profile.discord_id}`;

                const dlEmbed = new EmbedBuilder()
                    .setTitle(`Profil de ${titleName}`)
                    .setURL(profileUrl)
                    .setColor(embedColor)
                    .setThumbnail(profile.avatar_url || target.displayAvatarURL())
                    .setFooter({ text: `ID Discord : ${profile.discord_id}` })
                    .setTimestamp();

                // Bannière optionnelle
                if (profile.banner_url) {
                    dlEmbed.setImage(profile.banner_url);
                }

                // Bio optionnelle
                if (profile.bio && profile.bio.trim().length > 0) {
                    dlEmbed.setDescription(`*${profile.bio.trim()}*`);
                }

                // Champs : statut + booster sur la même ligne
                dlEmbed.addFields(
                    {
                        name: '📊 Statut',
                        value: profile.is_banned ? '🚫 Banni' : '✅ Actif',
                        inline: true
                    },
                    {
                        name: '🚀 Booster',
                        value: profile.is_booster ? '💜 Oui' : 'Non',
                        inline: true
                    },
                    // Champ vide pour aligner proprement sur 3 colonnes
                    { name: '\u200b', value: '\u200b', inline: true },
                    {
                        name: '🏆 Badges',
                        value: badgeDisplay,
                        inline: true
                    },
                    {
                        name: '📅 Membre depuis',
                        value: createdAtUnix ? `<t:${createdAtUnix}:D>` : 'Inconnu',
                        inline: true
                    }
                );

                // 7. Bouton "Voir le profil"
                const profileButton = new ButtonBuilder()
                    .setLabel('Voir le profil')
                    .setURL(profileUrl)
                    .setStyle(ButtonStyle.Link)
                    .setEmoji('🔗');

                const row = new ActionRowBuilder().addComponents(profileButton);

                message.channel.send({ embeds: [dlEmbed], components: [row] });
                break;
            }

            case 'id': {
                // On récupère le premier utilisateur mentionné
                const target = message.mentions.users.first();

                // Si personne n'est mentionné, on s'arrête
                if (!target) {
                    return message.reply("⚠️ Tu dois mentionner un utilisateur. Exemple : `!id @pseudo`");
                }

                // Envoi de l'ID dans un embed simple
                const idEmbed = new EmbedBuilder()
                    .setTitle(`ID de ${target.username}`)
                    .setColor('#5865F2')
                    .setDescription(`L'identifiant unique est : \`${target.id}\``)
                    .setThumbnail(target.displayAvatarURL())
                    .setTimestamp();

                message.channel.send({ embeds: [idEmbed] });
                break;
            }

            case 'userinfo': {
                const target = message.mentions.members.first() || message.member;
                const user = target.user;

                const roles = target.roles.cache
                    .filter(r => r.id !== message.guild.id)
                    .sort((a, b) => b.position - a.position)
                    .map(r => `<@&${r.id}>`)
                    .slice(0, 10);

                const rolesDisplay = roles.length ? roles.join(' ') : '`Aucun rôle`';

                const flags = user.flags?.toArray() ?? [];
                const badgeMap = {
                    Staff:                  '👨‍💼 Staff Discord',
                    Partner:                '🤝 Partenaire',
                    Hypesquad:              '🏠 HypeSquad Events',
                    BugHunterLevel1:        '🐛 Bug Hunter',
                    BugHunterLevel2:        '🐛 Bug Hunter Gold',
                    HypeSquadOnlineHouse1:  '🏠 Bravery',
                    HypeSquadOnlineHouse2:  '🏠 Brilliance',
                    HypeSquadOnlineHouse3:  '🏠 Balance',
                    PremiumEarlySupporter:  '💎 Early Supporter',
                    VerifiedDeveloper:      '🤖 Bot Developer',
                    ActiveDeveloper:        '⚡ Active Developer',
                    CertifiedModerator:     '🛡️ Certified Moderator',
                };
                const badges = flags.map(f => badgeMap[f]).filter(Boolean);

                const statusMap = { online: '🟢 En ligne', idle: '🟡 Absent', dnd: '🔴 Ne pas déranger', offline: '⚫ Hors ligne' };
                const presence = message.guild.presences.cache.get(user.id);
                const status = statusMap[presence?.status ?? 'offline'];

                const embed = new EmbedBuilder()
                    .setTitle(`👤 ${user.tag}`)
                    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
                    .setColor(target.displayHexColor !== '#000000' ? target.displayHexColor : '#5865F2')
                    .addFields(
                        { name: '🪪 ID',           value: `\`${user.id}\``,                                            inline: true },
                        { name: '📛 Pseudo serveur', value: target.nickname ?? user.username,                          inline: true },
                        { name: '🌐 Statut',        value: status,                                                     inline: true },
                        { name: '📅 Compte créé',   value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`,        inline: true },
                        { name: '📥 A rejoint le',  value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:D>`,       inline: true },
                        { name: '🤖 Bot',           value: user.bot ? 'Oui' : 'Non',                                  inline: true },
                        { name: `🎭 Rôles (${roles.length})`, value: rolesDisplay,                                     inline: false },
                    );

                if (badges.length) embed.addFields({ name: '🏅 Badges', value: badges.join('\n'), inline: false });

                const avatar = user.displayAvatarURL({ dynamic: true, size: 512 });
                embed.addFields({ name: '🖼️ Avatar', value: `[Voir en grand](${avatar})`, inline: false });
                embed.setImage(avatar).setTimestamp();

                message.channel.send({ embeds: [embed] });
                break;
            }

            case 'config': {
                if (!PRIVILEGED_IDS.has(message.author.id) && !isAdmin)
                    return message.reply('❌ Réservé aux admins et fondateurs.');
                return sendConfigMenu(message.channel, botConfig, client);
            }

            case 'giveaway':
            case 'gw': {
                if (!isMod) return message.reply("❌ Tu n'as pas la permission.");
                const sub = args.shift()?.toLowerCase();

                if (sub === 'start') {
                    const duration = args[0];
                    const winnersCount = parseInt(args[1]);
                    const prize = args.slice(2).join(" ");
                    if (!duration || isNaN(winnersCount) || winnersCount < 1 || !prize) {
                        return message.reply("❌ Usage : `!giveaway start <durée> <gagnants> <prix>`\nExemple : `!giveaway start 1h 2 Nitro Discord`");
                    }
                    const durationMs = ms(duration);
                    if (!durationMs || durationMs < 5000) return message.reply("❌ Durée invalide. Exemple : `10m`, `1h`, `2d`");
                    const endTime = Date.now() + durationMs;
                    const gwMsg = await message.channel.send({ embeds: [buildGiveawayEmbed(prize, winnersCount, endTime, message.author.id, 0)] });
                    await gwMsg.react(GIVEAWAY_EMOJI);
                    giveaways.set(gwMsg.id, { channelId: message.channel.id, prize, winnersCount, endTime, hostId: message.author.id, ended: false });
                    saveGiveaways();
                    message.reply(`✅ Giveaway lancé ! Il se termine <t:${Math.floor(endTime / 1000)}:R>.`);
                    setTimeout(() => endGiveaway(gwMsg.id), durationMs);
                    break;
                }

                if (sub === 'end') {
                    const msgId = args[0];
                    if (!msgId) return message.reply("❌ Usage : `!giveaway end <messageId>`");
                    const gw = giveaways.get(msgId);
                    if (!gw) return message.reply("❌ Giveaway introuvable.");
                    if (gw.ended) return message.reply("❌ Ce giveaway est déjà terminé.");
                    await endGiveaway(msgId);
                    message.reply("✅ Giveaway terminé manuellement.");
                    break;
                }

                if (sub === 'reroll') {
                    const msgId = args[0];
                    if (!msgId) return message.reply("❌ Usage : `!giveaway reroll <messageId>`");
                    const gw = giveaways.get(msgId);
                    if (!gw) return message.reply("❌ Giveaway introuvable.");
                    if (!gw.ended) return message.reply("❌ Le giveaway n'est pas encore terminé.");
                    try {
                        const channel = await client.channels.fetch(gw.channelId);
                        const gwMsg = await channel.messages.fetch(msgId);
                        const newWinners = await pickWinners(gwMsg, gw.winnersCount);
                        if (newWinners.length === 0) return message.reply("😔 Pas assez de participants pour reroll.");
                        const text = newWinners.map(w => `<@${w.id}>`).join(', ');
                        channel.send(`🔄 **Reroll !** Nouveau(x) gagnant(s) pour **${gw.prize}** : ${text} !`);
                        message.reply("✅ Reroll effectué !");
                    } catch (e) { message.reply("❌ Impossible de reroll : " + e.message); }
                    break;
                }

                if (sub === 'list') {
                    const active = [...giveaways.entries()].filter(([, gw]) => !gw.ended).map(([id, gw]) => {
                        const ts = Math.floor(gw.endTime / 1000);
                        return `• **${gw.prize}** — ${gw.winnersCount} gagnant(s) — Fin <t:${ts}:R> — [Message](https://discord.com/channels/${SERVER_ID}/${gw.channelId}/${id})`;
                    });
                    message.reply({ embeds: [new EmbedBuilder()
                        .setTitle('🎉 Giveaways en cours').setColor('#FFD700')
                        .setDescription(active.length > 0 ? active.join('\n') : 'Aucun giveaway en cours.')
                        .setTimestamp()
                    ]});
                    break;
                }

                message.reply("❌ Sous-commande inconnue. Utilise :\n`!giveaway start <durée> <gagnants> <prix>`\n`!giveaway end <messageId>`\n`!giveaway reroll <messageId>`\n`!giveaway list`");
                break;
            }
        }
    } catch (e) {
        console.error(e);
        message.reply("❌ Erreur. Vérifie les permissions du bot !");
    }
});

// ─── PARTICIPANTS EN TEMPS RÉEL ─────────────────────────────────────────────

async function updateParticipantCount(reaction) {
    if (reaction.emoji.name !== GIVEAWAY_EMOJI) return;
    const gw = giveaways.get(reaction.message.id);
    if (!gw || gw.ended) return;
    try {
        const msg = await reaction.message.fetch();
        const r = msg.reactions.cache.get(GIVEAWAY_EMOJI);
        const count = r ? r.count - 1 : 0;
        await msg.edit({ embeds: [buildGiveawayEmbed(gw.prize, gw.winnersCount, gw.endTime, gw.hostId, count)] });
    } catch (e) { console.error("Erreur mise à jour participant:", e); }
}

client.on(Events.MessageReactionAdd, async (reaction, user) => { if (!user.bot) await updateParticipantCount(reaction); });
client.on(Events.MessageReactionRemove, async (reaction, user) => { if (!user.bot) await updateParticipantCount(reaction); });

// ─── SERVEUR WEB ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cors());

app.post('/send-embed', async (req, res) => {
    const { channelId, title, description, color, image, thumbnail, authorName, authorIcon, footer } = req.body;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return res.status(404).send("Salon introuvable");
        const embed = new EmbedBuilder()
            .setTitle(title || null).setDescription(description || null)
            .setColor(color || '#00ff00').setImage(image || null).setThumbnail(thumbnail || null);
        if (authorName) embed.setAuthor({ name: authorName, iconURL: authorIcon || null });
        if (footer) embed.setFooter({ text: footer });
        await channel.send({ embeds: [embed] });
        res.status(200).send("Envoyé !");
    } catch (err) { res.status(500).send("Erreur : " + err.message); }
});

app.post('/giveaway/start', async (req, res) => {
    const { channelId, prize, winnersCount, duration } = req.body;
    if (!channelId || !prize || !winnersCount || !duration) return res.status(400).send("Champs manquants");
    const durationMs = ms(String(duration));
    if (!durationMs) return res.status(400).send("Durée invalide");
    try {
        const channel = await client.channels.fetch(channelId);
        const endTime = Date.now() + durationMs;
        const gwMsg = await channel.send({ embeds: [buildGiveawayEmbed(prize, winnersCount, endTime, client.user.id, 0)] });
        await gwMsg.react(GIVEAWAY_EMOJI);
        giveaways.set(gwMsg.id, { channelId, prize, winnersCount: parseInt(winnersCount), endTime, hostId: client.user.id, ended: false });
        saveGiveaways();
        setTimeout(() => endGiveaway(gwMsg.id), durationMs);
        res.status(200).json({ messageId: gwMsg.id, endTime });
    } catch (err) { res.status(500).send("Erreur : " + err.message); }
});

// ─── SYSTÈME DE RÔLE : STATUT + BIO + NOTE DE SERVEUR ───────────────────────
const SEARCH_LINK = "damnloads.com";
const ROLE_ID = "1491780566335492197";

// Vérifie si un membre a le lien dans son statut, sa bio globale ou sa note de serveur
async function checkMemberForSoutienRole(member) {
    if (!member || member.user.bot) return;

    let hasLink = false;

    try {
        // 1. Bio globale (À propos de moi)
        const user = await client.users.fetch(member.id, { force: true });
        if (user.bio && user.bio.includes(SEARCH_LINK)) hasLink = true;

        // 2. Note de serveur (serverProfile / aboutMe membre)
        if (!hasLink && user.aboutMe && user.aboutMe.includes(SEARCH_LINK)) hasLink = true;

        // 3. Statut personnalisé (la bulle)
        if (!hasLink) {
            const presence = member.presence;
            const customStatus = presence?.activities?.find(a => a.type === ActivityType.Custom);
            if (customStatus?.state && customStatus.state.includes(SEARCH_LINK)) hasLink = true;
        }

        // 4. Nickname (pseudo de serveur)
        if (!hasLink && member.nickname && member.nickname.includes(SEARCH_LINK)) hasLink = true;

    } catch (e) {
        console.error(`[Soutien] Erreur fetch user ${member.id}:`, e.message);
        return;
    }

    const hasRole = member.roles.cache.has(ROLE_ID);

    try {
        if (hasLink && !hasRole) {
            await member.roles.add(ROLE_ID);
            console.log(`✅ [Soutien] Rôle ajouté à ${member.user.tag} (${SEARCH_LINK} trouvé)`);
        } else if (!hasLink && hasRole) {
            await member.roles.remove(ROLE_ID);
            console.log(`❌ [Soutien] Rôle retiré à ${member.user.tag} (${SEARCH_LINK} absent)`);
        }
    } catch (error) {
        console.error(`[Soutien] Erreur modification rôle pour ${member.user.tag}:`, error.message);
    }
}

// Scan complet du serveur au démarrage
async function syncAllSoutienRoles() {
    const guild = client.guilds.cache.get(SERVER_ID);
    if (!guild) return;
    console.log("[Soutien] Scan complet au démarrage...");
    const members = guild.members.cache;
    let checked = 0;
    for (const [, member] of members) {
        if (!member.user.bot) {
            await checkMemberForSoutienRole(member);
            checked++;
            if (checked % 10 === 0) await new Promise(r => setTimeout(r, 1000));
        }
    }
    console.log(`[Soutien] Scan terminé : ${checked} membres vérifiés.`);
}

client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
    if (!newPresence?.member) return;
    if (newPresence.guild?.id !== SERVER_ID) return;
    await checkMemberForSoutienRole(newPresence.member);
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.guild.id !== SERVER_ID) return;

    const boosterRole = newMember.guild.roles.cache.find(r => r.tags?.premiumSubscriberRole);
    if (boosterRole) {
        const avaitRole = oldMember.roles.cache.has(boosterRole.id);
        const aRole     = newMember.roles.cache.has(boosterRole.id);
        if (!avaitRole && aRole) {
            await setBoosterStatus(newMember.id, true);
            console.log(`[DL] 💜 ${newMember.user.username} est maintenant Server Booster`);
        }
        if (avaitRole && !aRole) {
            await setBoosterStatus(newMember.id, false);
            console.log(`[DL] 🔴 ${newMember.user.username} a arrêté de booster`);
        }
    }

    await checkMemberForSoutienRole(newMember);
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── SYSTÈME !CONFIG ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function cfgVal(id) { return id ? `<#${id}>` : '`Non défini`'; }
function cfgRole(id) { return id ? `<@&${id}>` : '`Non défini`'; }
function cfgBool(v)  { return v ? '✅ Activé' : '❌ Désactivé'; }

function buildConfigEmbed(cfg, client) {
    return new EmbedBuilder()
        .setTitle('⚙️  Configuration du Bot')
        .setColor('#5865F2')
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
            { name: '📋 Général', value:
                `**Préfixe :** \`${cfg.prefix}\`\n` +
                `**Canal logs :** ${cfgVal(cfg.logChannel)}\n` +
                `**Canal bienvenue :** ${cfgVal(cfg.welcomeChannel)}\n` +
                `**Message bienvenue :** \`${cfg.welcomeMessage}\``,
              inline: false },
            { name: '👥 Rôles', value:
                `**Rôle auto (nouveau membre) :** ${cfgRole(cfg.autoRole)}\n` +
                `**Rôle modérateur :** ${cfgRole(cfg.modRole)}\n` +
                `**Rôle muet :** ${cfgRole(cfg.mutedRole)}`,
              inline: false },
            { name: '🛡️ Anti-Spam', value:
                `**Statut :** ${cfgBool(cfg.antiSpam)}\n` +
                `**Seuil :** \`${cfg.antiSpamThreshold}\` messages en \`${cfg.antiSpamInterval}s\``,
              inline: false },
            { name: '🎉 Giveaway', value:
                `**Canal giveaway :** ${cfgVal(cfg.giveawayChannel)}`,
              inline: false },
            { name: '🎮 Notifs Jeux', value:
                `**Canal notifications jeux :** ${cfgVal(cfg.gameNotifChannel)}`,
              inline: false },
        )
        .setFooter({ text: 'Utilise le menu ci-dessous pour modifier une section' })
        .setTimestamp();
}

function buildMainMenu() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('cfg_section')
            .setPlaceholder('📂 Choisir une section à configurer...')
            .addOptions([
                { label: '📋 Général',        description: 'Préfixe, logs, bienvenue',          value: 'general',   emoji: '📋' },
                { label: '👥 Rôles',           description: 'Auto-rôle, modérateur, muet',       value: 'roles',     emoji: '👥' },
                { label: '🛡️ Anti-Spam',       description: 'Seuil et intervalle anti-spam',     value: 'antispam',  emoji: '🛡️' },
                { label: '🎉 Giveaway',        description: 'Canal des giveaways',               value: 'giveaway',   emoji: '🎉' },
                { label: '🎮 Notifs Jeux',      description: 'Canal des nouvelles sorties',        value: 'gamenotif',  emoji: '🎮' },
                { label: '🔄 Réinitialiser',   description: 'Remettre la config par défaut',     value: 'reset',     emoji: '🔄' },
            ])
    );
}

async function sendConfigMenu(channel, cfg, client) {
    return channel.send({
        embeds: [buildConfigEmbed(cfg, client)],
        components: [buildMainMenu()],
    });
}

function generalButtons(cfg) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cfg_set_prefix').setLabel('✏️ Changer le préfixe').setStyle(2),
            new ButtonBuilder().setCustomId('cfg_set_welcome_msg').setLabel('💬 Message bienvenue').setStyle(2),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cfg_set_log_channel').setLabel('📋 Canal de logs').setStyle(1),
            new ButtonBuilder().setCustomId('cfg_set_welcome_channel').setLabel('👋 Canal bienvenue').setStyle(1),
            new ButtonBuilder().setCustomId('cfg_back').setLabel('↩ Retour').setStyle(4),
        ),
    ];
}

function rolesButtons() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cfg_set_autorole').setLabel('🤖 Rôle auto').setStyle(2),
            new ButtonBuilder().setCustomId('cfg_set_modrole').setLabel('🛠️ Rôle modérateur').setStyle(2),
            new ButtonBuilder().setCustomId('cfg_set_muterole').setLabel('🔇 Rôle muet').setStyle(2),
            new ButtonBuilder().setCustomId('cfg_back').setLabel('↩ Retour').setStyle(4),
        ),
    ];
}

function antispamButtons(cfg) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('cfg_toggle_antispam')
                .setLabel(cfg.antiSpam ? '❌ Désactiver l\'anti-spam' : '✅ Activer l\'anti-spam')
                .setStyle(cfg.antiSpam ? 4 : 3),
            new ButtonBuilder().setCustomId('cfg_set_spam_threshold').setLabel('⚙️ Modifier le seuil').setStyle(2),
            new ButtonBuilder().setCustomId('cfg_back').setLabel('↩ Retour').setStyle(4),
        ),
    ];
}

function giveawayButtons() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cfg_set_giveaway_channel').setLabel('🎉 Canal giveaway').setStyle(1),
            new ButtonBuilder().setCustomId('cfg_back').setLabel('↩ Retour').setStyle(4),
        ),
    ];
}

function gamenotifButtons() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cfg_set_gamenotif_channel').setLabel('🎮 Canal notifs jeux').setStyle(1),
            new ButtonBuilder().setCustomId('cfg_back').setLabel('↩ Retour').setStyle(4),
        ),
    ];
}

async function askForChannel(interaction, label, cfgKey) {
    await interaction.reply({ content: `📌 **${label}** — Mentionne le salon souhaité (ex: <#123456>) ou tape son ID. Tu as 30s.`, ephemeral: true });
    const filter = m => m.author.id === interaction.user.id;
    try {
        const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        const msg = collected.first();
        const channelId = msg.mentions.channels.first()?.id || msg.content.trim().replace(/[^0-9]/g, '');
        const chan = interaction.guild.channels.cache.get(channelId);
        if (!chan) return interaction.followUp({ content: '❌ Salon introuvable.', ephemeral: true });
        botConfig[cfgKey] = chan.id;
        saveConfig(botConfig);
        msg.delete().catch(() => {});
        return interaction.followUp({ content: `✅ **${label}** défini sur ${chan}.`, ephemeral: true });
    } catch {
        return interaction.followUp({ content: '⏱️ Temps écoulé.', ephemeral: true });
    }
}

async function askForRole(interaction, label, cfgKey) {
    await interaction.reply({ content: `🎭 **${label}** — Mentionne le rôle (ex: <@&123456>) ou tape son ID. Tu as 30s.`, ephemeral: true });
    const filter = m => m.author.id === interaction.user.id;
    try {
        const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        const msg = collected.first();
        const roleId = msg.mentions.roles.first()?.id || msg.content.trim().replace(/[^0-9]/g, '');
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) return interaction.followUp({ content: '❌ Rôle introuvable.', ephemeral: true });
        botConfig[cfgKey] = role.id;
        saveConfig(botConfig);
        msg.delete().catch(() => {});
        return interaction.followUp({ content: `✅ **${label}** défini sur ${role}.`, ephemeral: true });
    } catch {
        return interaction.followUp({ content: '⏱️ Temps écoulé.', ephemeral: true });
    }
}

client.on(Events.InteractionCreate, async (interaction) => {
    const isPriv  = PRIVILEGED_IDS.has(interaction.user.id);
    const isAdm   = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isPriv && !isAdm) {
        if (interaction.isRepliable()) return interaction.reply({ content: '❌ Accès refusé.', ephemeral: true });
        return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'cfg_section') {
        const section = interaction.values[0];

        if (section === 'reset') {
            botConfig = {
                logChannel: null, welcomeChannel: null,
                welcomeMessage: 'Bienvenue sur le serveur, {user} ! 🎉',
                autoRole: null, modRole: null, mutedRole: null,
                antiSpam: false, antiSpamThreshold: 5, antiSpamInterval: 3,
                giveawayChannel: null, gameNotifChannel: null, prefix: '!',
            };
            saveConfig(botConfig);
            await interaction.update({
                embeds: [buildConfigEmbed(botConfig, client).setDescription('🔄 Config réinitialisée !')],
                components: [buildMainMenu()],
            });
            return;
        }

        const sectionEmbeds = {
            general:  new EmbedBuilder().setTitle('📋 Configuration — Général').setColor('#5865F2')
                        .setDescription('Configure le préfixe, le salon de logs et le message de bienvenue.'),
            roles:    new EmbedBuilder().setTitle('👥 Configuration — Rôles').setColor('#5865F2')
                        .setDescription('Configure les rôles automatiques, modérateur et muet.'),
            antispam: new EmbedBuilder().setTitle('🛡️ Configuration — Anti-Spam').setColor('#5865F2')
                        .setDescription(`Statut actuel : **${cfgBool(botConfig.antiSpam)}**\nSeuil : \`${botConfig.antiSpamThreshold}\` msgs / \`${botConfig.antiSpamInterval}s\``),
            giveaway: new EmbedBuilder().setTitle('🎉 Configuration — Giveaway').setColor('#5865F2')
                        .setDescription('Configure le canal dédié aux giveaways.'),
            gamenotif: new EmbedBuilder().setTitle('🎮 Configuration — Notifs Jeux').setColor('#5865F2')
                        .setDescription('Configure le canal où les nouvelles sorties de jeux sont annoncées.'),
        };

        const sectionComponents = {
            general:   generalButtons(botConfig),
            roles:     rolesButtons(),
            antispam:  antispamButtons(botConfig),
            giveaway:  giveawayButtons(),
            gamenotif: gamenotifButtons(),
        };

        await interaction.update({
            embeds: [sectionEmbeds[section]],
            components: sectionComponents[section],
        });
        return;
    }

    if (interaction.isButton() && interaction.customId === 'cfg_back') {
        await interaction.update({
            embeds: [buildConfigEmbed(botConfig, client)],
            components: [buildMainMenu()],
        });
        return;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_prefix') {
            const val = interaction.fields.getTextInputValue('input_prefix').trim();
            if (!val || val.length > 3) return interaction.reply({ content: '❌ Préfixe invalide (1-3 caractères).', ephemeral: true });
            botConfig.prefix = val;
            saveConfig(botConfig);
            return interaction.reply({ content: `✅ Préfixe changé en \`${val}\`\n⚠️ Redémarre le bot pour l'appliquer.`, ephemeral: true });
        }
        if (interaction.customId === 'modal_welcome_msg') {
            const val = interaction.fields.getTextInputValue('input_welcome_msg');
            botConfig.welcomeMessage = val;
            saveConfig(botConfig);
            return interaction.reply({ content: `✅ Message de bienvenue mis à jour :\n> ${val}`, ephemeral: true });
        }
        if (interaction.customId === 'modal_spam_threshold') {
            const threshold = parseInt(interaction.fields.getTextInputValue('input_threshold'));
            const interval  = parseInt(interaction.fields.getTextInputValue('input_interval'));
            if (isNaN(threshold) || isNaN(interval) || threshold < 2 || interval < 1)
                return interaction.reply({ content: '❌ Valeurs invalides. Seuil ≥ 2, intervalle ≥ 1.', ephemeral: true });
            botConfig.antiSpamThreshold = threshold;
            botConfig.antiSpamInterval  = interval;
            saveConfig(botConfig);
            return interaction.reply({ content: `✅ Anti-spam : **${threshold}** messages en **${interval}s**.`, ephemeral: true });
        }
        return;
    }

    if (!interaction.isButton()) return;

    if (interaction.customId === 'cfg_set_prefix') {
        const modal = new ModalBuilder().setCustomId('modal_prefix').setTitle('✏️ Changer le préfixe');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('input_prefix').setLabel('Nouveau préfixe (1-3 caractères)')
                .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(3)
                .setValue(botConfig.prefix).setRequired(true)
        ));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'cfg_set_welcome_msg') {
        const modal = new ModalBuilder().setCustomId('modal_welcome_msg').setTitle('💬 Message de bienvenue');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('input_welcome_msg').setLabel('Message ({user} = mention du membre)')
                .setStyle(TextInputStyle.Paragraph).setMaxLength(500)
                .setValue(botConfig.welcomeMessage).setRequired(true)
        ));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'cfg_set_spam_threshold') {
        const modal = new ModalBuilder().setCustomId('modal_spam_threshold').setTitle('⚙️ Seuil anti-spam');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('input_threshold').setLabel('Nombre de messages max')
                    .setStyle(TextInputStyle.Short).setMaxLength(3)
                    .setValue(String(botConfig.antiSpamThreshold)).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('input_interval').setLabel('Intervalle en secondes')
                    .setStyle(TextInputStyle.Short).setMaxLength(3)
                    .setValue(String(botConfig.antiSpamInterval)).setRequired(true)
            ),
        );
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'cfg_set_log_channel')       return askForChannel(interaction, 'Canal de logs',      'logChannel');
    if (interaction.customId === 'cfg_set_welcome_channel')   return askForChannel(interaction, 'Canal de bienvenue', 'welcomeChannel');
    if (interaction.customId === 'cfg_set_giveaway_channel')  return askForChannel(interaction, 'Canal giveaway',         'giveawayChannel');
    if (interaction.customId === 'cfg_set_gamenotif_channel') return askForChannel(interaction, 'Canal notifs jeux',      'gameNotifChannel');
    if (interaction.customId === 'cfg_set_autorole')          return askForRole(interaction,    'Rôle auto',          'autoRole');
    if (interaction.customId === 'cfg_set_modrole')           return askForRole(interaction,    'Rôle modérateur',    'modRole');
    if (interaction.customId === 'cfg_set_muterole')          return askForRole(interaction,    'Rôle muet',          'mutedRole');

    if (interaction.customId === 'cfg_toggle_antispam') {
        botConfig.antiSpam = !botConfig.antiSpam;
        saveConfig(botConfig);
        await interaction.update({
            embeds: [new EmbedBuilder().setTitle('🛡️ Configuration — Anti-Spam').setColor('#5865F2')
                .setDescription(`Statut actuel : **${cfgBool(botConfig.antiSpam)}**\nSeuil : \`${botConfig.antiSpamThreshold}\` msgs / \`${botConfig.antiSpamInterval}s\``)],
            components: antispamButtons(botConfig),
        });
        return;
    }
});

// ─── Anti-Spam (si activé) ───────────────────────────────────────────────────
const spamMap = new Map();
client.on(Events.MessageCreate, async (msg) => {
    if (!botConfig.antiSpam || msg.author.bot || !msg.guild) return;
    if (PRIVILEGED_IDS.has(msg.author.id)) return;
    if (msg.member?.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
    const key = msg.author.id;
    const now = Date.now();
    if (!spamMap.has(key)) spamMap.set(key, []);
    const times = spamMap.get(key).filter(t => now - t < botConfig.antiSpamInterval * 1000);
    times.push(now);
    spamMap.set(key, times);
    if (times.length >= botConfig.antiSpamThreshold) {
        spamMap.delete(key);
        try {
            await msg.member.timeout(10000, 'Anti-spam automatique');
            msg.channel.send(`🛑 <@${msg.author.id}> a été muté 10s pour spam.`).then(m => setTimeout(() => m.delete().catch(() => {}), 8000));
        } catch (e) { console.error('[Anti-spam]', e.message); }
    }
}, { once: false });

app.listen(3000, () => console.log("🌐 Interface web liée à ta mère la pute sur http://localhost:3000"));

client.login(TOKEN);
