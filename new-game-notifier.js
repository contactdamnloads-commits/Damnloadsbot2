// ─── new-game-notifier.js ─────────────────────────────────────────────────────
// Surveille Supabase et poste un message dans un salon Discord
// à chaque nouveau jeu ajouté sur le site.
//
// Si le bot était éteint, il rattrape TOUS les jeux manqués au redémarrage.
//
// Intégration dans gemini-code-*.js :
//   require('./new-game-notifier')(client, supabase);
//
// Variables à définir dans .env :
//   NEW_GAME_CHANNEL_ID=<id du salon où poster les annonces>
//   SITE_URL=https://damnloads.com   (déjà présent)
//   POLL_INTERVAL_GAMES=120000                    (optionnel, défaut 2 min)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const notifierState = require('./notifier-state');

// ─── Config ─────────────────────────────────────────────────────────────────
// CHANNEL_ID est résolu dynamiquement via getChannelId() pour supporter !config
let _getChannelId = () => process.env.NEW_GAME_CHANNEL_ID || '1502840727988863047';
const SITE_URL      = (process.env.SITE_URL || 'https://damnloads.com').replace(/\/$/, '');
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_GAMES) || 2 * 60 * 1000; // 2 min

// ─── Icône selon le type/catégorie ────────────────────────────────────────────
function typeIcon(type, cat) {
    const t = (type || '').toLowerCase();
    const c = (cat  || '').toLowerCase();
    if (t.includes('jeu') || t.includes('game'))      return '🎮';
    if (t.includes('logiciel') || t.includes('soft')) return '💻';
    if (t.includes('film') || t.includes('movie'))    return '🎬';
    if (t.includes('serie') || t.includes('série'))   return '📺';
    if (t.includes('musique') || t.includes('music')) return '🎵';
    if (c.includes('action'))   return '⚔️';
    if (c.includes('sport'))    return '⚽';
    if (c.includes('rpg'))      return '🧙';
    if (c.includes('strateg'))  return '♟️';
    return '📦';
}

// ─── Validation d'URL ────────────────────────────────────────────────────────
function isValidUrl(str) {
    try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch { return false; }
}

// ─── Construit l'embed d'annonce ──────────────────────────────────────────────
function buildGameEmbed(game, isCatchup = false) {
    const ico      = typeIcon(game.type, game.cat);
    const gameUrl  = `${SITE_URL}/game?id=${game.id}`;
    const label    = isCatchup ? '📥 Jeu ajouté pendant l\'absence du bot' : '🆕 Nouveau jeu disponible !';

    const embed = new EmbedBuilder()
        .setTitle(`${ico}  ${game.name || 'Sans titre'}`)
        .setURL(gameUrl)
        .setColor(isCatchup ? '#888888' : '#00ff41')
        .setFooter({ text: label })
        .setTimestamp();

    // Champs d'info
    const fields = [];

    if (game.type || game.cat) {
        fields.push({
            name: '📂 Catégorie',
            value: [game.type, game.cat].filter(Boolean).join(' · ') || '—',
            inline: true,
        });
    }

    if (game.ver) {
        fields.push({ name: '🔖 Version', value: game.ver, inline: true });
    }

    if (game.badge) {
        fields.push({ name: '🏷️ Badge', value: game.badge, inline: true });
    }

    if (game.bio) {
        const bio = game.bio.length > 300 ? game.bio.slice(0, 297) + '…' : game.bio;
        fields.push({ name: '📝 Description', value: bio, inline: false });
    }

    if (fields.length > 0) embed.addFields(fields);

    // Image de couverture depuis Supabase
    if (game.img && isValidUrl(game.img)) {
        embed.setImage(game.img);
    }

    return embed;
}

// ─── Construit le bouton "Voir le jeu" ────────────────────────────────────────
function buildRow(game) {
    const gameUrl = `${SITE_URL}/game?id=${game.id}`;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Voir le jeu')
            .setURL(gameUrl)
            .setStyle(ButtonStyle.Link)
            .setEmoji('🔗'),
    );

    return row;
}

// ─── Poste un jeu dans le salon ───────────────────────────────────────────────
async function postGame(channel, game, isCatchup = false) {
    try {
        const embed = buildGameEmbed(game, isCatchup);
        const row   = buildRow(game);

        // Debug : log les valeurs critiques avant d'envoyer
        console.log(`[GameNotifier] Tentative post id=${game.id} | img="${game.img}" | link="${game.link}" | name="${game.name}"`);

        await channel.send({
            embeds: [embed],
            components: [row],
        });
        console.log(`[GameNotifier] ✅ Posté : "${game.name}" (id=${game.id})${isCatchup ? ' [catchup]' : ''}`);
    } catch (err) {
        console.error(`[GameNotifier] ❌ Erreur id=${game.id} :`, err.message);
        // Log brut Discord
        if (err.rawError)  console.error('[GameNotifier] rawError:', JSON.stringify(err.rawError));
        if (err.errors)    console.error('[GameNotifier] errors:', JSON.stringify(err.errors));

        // Retry sans image ni boutons pour isoler le problème
        try {
            console.log('[GameNotifier] Retry sans image/boutons...');
            const fallbackEmbed = new EmbedBuilder()
                .setTitle(game.name || 'Sans titre')
                .setColor('#ff4444')
                .setDescription(`⚠️ Erreur d'affichage — [Voir le jeu](${SITE_URL}/game?id=${game.id})
\`${err.message}\``);
            await channel.send({ embeds: [fallbackEmbed] });
            console.log('[GameNotifier] ✅ Fallback posté pour id=' + game.id);
        } catch (e2) {
            console.error('[GameNotifier] ❌ Fallback aussi échoué :', e2.message);
        }
    }
}

// ─── Récupère les jeux plus récents que lastSeenId ────────────────────────────
async function fetchNewGames(supabase, lastSeenId) {
    const { data, error } = await supabase
        .from('games')
        .select('id, name, type, cat, ver, badge, img, link, bio, trailer')
        .gt('id', lastSeenId)
        .order('id', { ascending: true });

    if (error) throw new Error(error.message);
    return data || [];
}

// ─── Boucle de vérification ───────────────────────────────────────────────────
async function checkAndPost(client, supabase, state, isCatchup = false) {
    const CHANNEL_ID = _getChannelId();
    if (!CHANNEL_ID) {
        console.warn('[GameNotifier] ⚠️ Canal non défini (NEW_GAME_CHANNEL_ID ou !config)');
        return;
    }

    let channel;
    try {
        channel = await client.channels.fetch(CHANNEL_ID);
    } catch {
        console.error('[GameNotifier] ❌ Impossible de récupérer le salon', CHANNEL_ID);
        return;
    }

    let newGames;
    try {
        newGames = await fetchNewGames(supabase, state.lastSeenId);
    } catch (err) {
        console.error('[GameNotifier] ❌ Erreur Supabase :', err.message);
        return;
    }

    if (newGames.length === 0) return;

    console.log(`[GameNotifier] ${newGames.length} nouveau(x) jeu(x) trouvé(s).`);

    // Si catchup de plusieurs jeux, envoie d'abord un message récap
    if (isCatchup && newGames.length > 1) {
        try {
            await channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`📥 Rattrapage — ${newGames.length} jeux ajoutés pendant l'absence du bot`)
                        .setColor('#555555')
                        .setDescription(newGames.map(g => `• **${g.name}** — [Voir](${SITE_URL}/game?id=${g.id})`).join('\n'))
                        .setTimestamp(),
                ],
            });
        } catch {}
    }

    // Poste chaque jeu un par un (avec délai pour éviter le rate limit Discord)
    for (const game of newGames) {
        await postGame(channel, game, isCatchup);
        if (newGames.length > 1) {
            await new Promise(r => setTimeout(r, 1200)); // 1.2s entre chaque post
        }
    }

    // Met à jour le dernier ID vu
    state.lastSeenId = newGames[newGames.length - 1].id;
    await notifierState.saveState(state);
}

// ─── Commande !postallgames ───────────────────────────────────────────────────
async function handlePostAllGames(message, supabase) {
    const { PermissionsBitField } = require('discord.js');

    // Admins uniquement
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply({ content: '❌ Commande réservée aux administrateurs.', ephemeral: true });
    }

    const TARGET_CHANNEL_ID = '1502840727988863047';

    let channel;
    try {
        channel = await message.client.channels.fetch(TARGET_CHANNEL_ID);
    } catch {
        return message.reply("❌ Impossible d'accéder au salon cible.");
    }

    // Récupère TOUS les jeux par ordre croissant (du plus ancien au plus récent)
    let games;
    try {
        const { data, error } = await supabase
            .from('games')
            .select('id, name, type, cat, ver, badge, img, link, bio, trailer')
            .order('id', { ascending: true });

        if (error) throw error;
        games = data || [];
    } catch (err) {
        return message.reply(`❌ Erreur Supabase : ${err.message}`);
    }

    if (games.length === 0) {
        return message.reply('📭 Aucun jeu trouvé dans la base de données.');
    }

    const confirm = await message.reply(
        `⚠️ Tu es sur le point de poster **${games.length} jeux** dans <#${TARGET_CHANNEL_ID}>. Réponds \`oui\` pour confirmer.`
    );

    // Attend confirmation
    const filter = m => m.author.id === message.author.id && m.content.toLowerCase() === 'oui';
    let collected;
    try {
        collected = await message.channel.awaitMessages({ filter, max: 1, time: 30_000, errors: ['time'] });
    } catch {
        return message.reply('⏱️ Temps écoulé, commande annulée.');
    }

    await message.reply(`✅ Lancement de l'envoi de ${games.length} jeux...`);

    for (const game of games) {
        await postGame(channel, game, false);
        // Pause pour éviter le rate limit Discord (messages lourds avec images)
        await new Promise(r => setTimeout(r, 1500));
    }

    // Met à jour le lastSeenId pour ne pas re-poster au prochain poll
    try {
        const state = await notifierState.loadState();
        state.lastSeenId = games[games.length - 1].id;
        await notifierState.saveState(state);
    } catch {}

    message.reply(`✅ Terminé ! **${games.length}** jeux postés dans <#${TARGET_CHANNEL_ID}>.`);
}

module.exports = function setupGameNotifier(client, supabase, getChannelId) {
    // Si un getter dynamique est fourni (depuis botConfig), on l'utilise
    if (typeof getChannelId === 'function') _getChannelId = getChannelId;

    const CHANNEL_ID = _getChannelId();
    if (!CHANNEL_ID) {
        console.warn('[GameNotifier] ⚠️ NEW_GAME_CHANNEL_ID non défini — module désactivé.');
        return;
    }

    // Initialise le système d'état persistant (Supabase)
    notifierState.init(supabase);

    // Commande !postallgames
    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;
        if (!message.content.startsWith('!postallgames')) return;
        await handlePostAllGames(message, supabase);
    });

    client.once('clientReady', async () => {
        console.log('[GameNotifier] Démarrage — vérification des jeux manqués...');

        const state = await notifierState.loadState();

        // Si c'est le premier démarrage (pas d'état), on prend l'ID max actuel
        // pour ne pas re-poster tout l'historique
        if (state.lastSeenId === 0) {
            try {
                const { data } = await supabase
                    .from('games')
                    .select('id')
                    .order('id', { ascending: false })
                    .limit(1);

                if (data && data.length > 0) {
                    state.lastSeenId = data[0].id;
                    await notifierState.saveState(state);
                    console.log(`[GameNotifier] 1er démarrage — ID de référence : ${state.lastSeenId}`);
                }
            } catch (err) {
                console.error('[GameNotifier] Erreur init :', err.message);
            }
            return; // Rien à rattraper au 1er démarrage
        }

        // Rattrapage des jeux manqués pendant l'extinction du bot
        await checkAndPost(client, supabase, state, true);

        // Polling toutes les X minutes
        setInterval(() => checkAndPost(client, supabase, state, false), POLL_MS);
    });
};
