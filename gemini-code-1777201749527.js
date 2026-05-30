require('dotenv').config();

const { 
    Client, GatewayIntentBits, ActivityType, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, Events, PermissionsBitField, EmbedBuilder 
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
const SITE_URL = 'https://damnloads-vault.vercel.app/';
const GIVEAWAY_EMOJI = '🎉';
const GIVEAWAY_FILE = './giveaways.json';

const warns = new Map();
let raidMode = false;

require('./role-sync')(client);
require('./recent-games')(client, supabase);
require('./new-game-notifier')(client, supabase);

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

    // Restaure tous les giveaways actifs sauvegardés
    let restored = 0;
    for (const [messageId, gw] of giveaways) {
        if (!gw.ended) { scheduleGiveaway(messageId); restored++; }
    }
    if (restored > 0) console.log(`🔄 ${restored} giveaway(s) restauré(s).`);

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

client.on(Events.GuildMemberAdd, member => {
    if (raidMode) member.kick("Raidmode actif").catch(console.error);
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

    if (message.channel.id === SITE_CHANNEL_ID && message.content.toLowerCase() === 'site') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Lien du Site').setURL(SITE_URL).setStyle(ButtonStyle.Link)
        );
        return message.reply({ content: "Voici l'accès au site :", components: [row] });
    }

    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const isMod = message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers);
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

    try {
        switch (command) {

            case 'help': {
                message.reply({ embeds: [new EmbedBuilder()
                    .setTitle('📚 Liste des Commandes').setColor('#00ff00')
                    .setThumbnail(client.user.displayAvatarURL())
                    .addFields(
                        { name: '🛠️ Modération', value: '`kick`, `ban`, `tempban`, `timeout`, `untimeout`, `clear`, `warn`' },
                        { name: '🛡️ Sécurité', value: '`lock`, `unlock`, `raidmode` (Admin uniquement)' },
                        { name: '⚙️ Configuration', value: '`slowmode [sec]`, `userinfo`' },
                        { name: '🎉 Giveaway', value: '`giveaway start <durée> <gagnants> <prix>`\n`giveaway end <messageId>`\n`giveaway reroll <messageId>`\n`giveaway list`' },
                        { name: '🌐 Autres', value: '`site` (dans le canal dédié), `help`' }
                    )
                    .setFooter({ text: 'Prefix actuel : !' })
                ]});
                break;
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
                await tbMem.ban({ reason: `Tempban: ${args.slice(2).join(" ")}` });
                message.reply(`⏳ **${tbMem.user.tag}** banni pour ${time}.`);
                setTimeout(() => message.guild.members.unban(tbMem.id).catch(() => {}), ms(time));
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
                warns.get(wUser.id).push(args.slice(1).join(" ") || "Raison non spécifiée");
                message.reply(`⚠️ **${wUser.tag}** a été warn. (Total: ${warns.get(wUser.id).length})`);
                break;
            }

            case 'raidmode': {
                if (!isAdmin) return;
                raidMode = !raidMode;
                message.reply(raidMode ? "🚨 **RAIDMODE ACTIVÉ**" : "✅ **RAIDMODE DÉSACTIVÉ**");
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
                    saveGiveaways(); // ← sauvegarde immédiate
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
        // Discord.js expose ça via member.user après un fetch forcé
        if (!hasLink && user.aboutMe && user.aboutMe.includes(SEARCH_LINK)) hasLink = true;

        // 3. Statut personnalisé (la bulle)
        if (!hasLink) {
            const presence = member.presence;
            const customStatus = presence?.activities?.find(a => a.type === ActivityType.Custom);
            if (customStatus?.state && customStatus.state.includes(SEARCH_LINK)) hasLink = true;
        }

        // 4. Nickname (pseudo de serveur) — certains mettent le lien dedans
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

// Scan complet du serveur au démarrage (utilise le cache chargé dans ready)
async function syncAllSoutienRoles() {
    const guild = client.guilds.cache.get(SERVER_ID);
    if (!guild) return;
    console.log("[Soutien] Scan complet au démarrage...");
    const members = guild.members.cache; // cache déjà chargé par le ready
    let checked = 0;
    for (const [, member] of members) {
        if (!member.user.bot) {
            await checkMemberForSoutienRole(member);
            checked++;
            // Petit délai pour éviter le rate limit Discord
            if (checked % 10 === 0) await new Promise(r => setTimeout(r, 1000));
        }
    }
    console.log(`[Soutien] Scan terminé : ${checked} membres vérifiés.`);
}

// Déclenché quand le statut/présence change
client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
    if (!newPresence?.member) return;
    if (newPresence.guild?.id !== SERVER_ID) return;
    await checkMemberForSoutienRole(newPresence.member);
});

// Déclenché quand un membre est mis à jour (nickname, rôles, note de serveur...)
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.guild.id !== SERVER_ID) return;

    // Gestion boosters (existant)
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

    // Vérification du rôle Soutien (nickname ou note de serveur modifiés)
    await checkMemberForSoutienRole(newMember);
});

app.listen(3000, () => console.log("🌐 Interface web liée à ta mère la pute sur http://localhost:3000"));

client.login(TOKEN);
