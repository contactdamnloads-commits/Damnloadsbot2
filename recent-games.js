// ─── recent-games.js ──────────────────────────────────────────────────────────
// Ajoute ce fichier à côté de gemini-code-*.js
// puis dans le bot principal, ajoute : require('./recent-games')(client, supabase)
//
// Commande : !recents [nombre]
//   → Affiche les jeux ajoutés récemment depuis Supabase
//   → Pagination avec boutons ◀ ▶
//   → Filtrage : !recents 20  (affiche les 20 derniers, max 50)
// ─────────────────────────────────────────────────────────────────────────────

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

const ITEMS_PER_PAGE = 5;   // jeux affichés par page
const MAX_GAMES      = 50;  // limite max récupérée depuis Supabase
const TIMEOUT_MS     = 60_000; // expire après 60s d'inactivité

// ─── Icône selon le type/catégorie ────────────────────────────────────────────
function typeIcon(type, cat) {
    const t = (type || '').toLowerCase();
    const c = (cat  || '').toLowerCase();
    if (t.includes('jeu') || t.includes('game'))  return '🎮';
    if (t.includes('logiciel') || t.includes('soft')) return '💻';
    if (t.includes('film') || t.includes('movie'))    return '🎬';
    if (t.includes('serie') || t.includes('série'))   return '📺';
    if (t.includes('musique') || t.includes('music')) return '🎵';
    if (c.includes('action'))    return '⚔️';
    if (c.includes('sport'))     return '⚽';
    if (c.includes('rpg'))       return '🧙';
    if (c.includes('strateg'))   return '♟️';
    return '📦';
}

// ─── Formate une date ISO en "DD/MM/YYYY à HH:MM" ─────────────────────────────
function fmtDate(iso) {
    if (!iso) return 'Date inconnue';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Construit l'embed pour une page donnée ───────────────────────────────────
function buildEmbed(games, page, totalPages, totalCount) {
    const start = page * ITEMS_PER_PAGE;
    const slice = games.slice(start, start + ITEMS_PER_PAGE);

    const embed = new EmbedBuilder()
        .setTitle('🕐 Jeux ajoutés récemment')
        .setColor('#00ff41')
        .setFooter({
            text: `Page ${page + 1}/${totalPages} · ${totalCount} jeu${totalCount > 1 ? 'x' : ''} récupéré${totalCount > 1 ? 's' : ''}`
        })
        .setTimestamp();

    slice.forEach((game, i) => {
        const ico  = typeIcon(game.type, game.cat);
        const num  = start + i + 1;
        const name = game.name || 'Sans titre';
        const ver  = game.ver  ? ` · v${game.ver}` : '';
        const type = game.type || game.cat || 'Inconnu';
        const date = game.badge ? `🏷️ ${game.badge}` : '';
        const link = game.link ? `[↗ Lien](${game.link})` : '*(pas de lien)*';

        embed.addFields({
            name: `${ico} #${num} — ${name}${ver}`,
            value: `> **Type :** ${type}\n> **Réf. :** #${game.id}${date ? '  ·  ' + date : ''}\n> ${link}`,
            inline: false,
        });
    });

    if (slice.length === 0) {
        embed.setDescription('*Aucun jeu trouvé.*');
    }

    return embed;
}

// ─── Construit la ligne de boutons de pagination ──────────────────────────────
function buildRow(page, totalPages, uid) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`recents_prev_${uid}`)
            .setLabel('◀ Précédent')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`recents_page_${uid}`)
            .setLabel(`${page + 1} / ${totalPages}`)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`recents_next_${uid}`)
            .setLabel('Suivant ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1),
    );
}

// ─── Module principal ─────────────────────────────────────────────────────────
module.exports = function setupRecentGames(client, supabase) {

    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;
        if (!message.content.startsWith('!recents')) return;

        // Parse le nombre optionnel : !recents 20
        const args  = message.content.trim().split(/ +/);
        const limit = Math.min(parseInt(args[1]) || 10, MAX_GAMES);

        // Récupère les jeux depuis Supabase, triés par date de création desc
        let games;
        try {
            const { data, error } = await supabase
                .from('games')
                .select('id, name, type, cat, ver, link, badge')
                .order('id', { ascending: false })
                .limit(limit);

            if (error) throw error;
            games = data || [];
        } catch (err) {
            console.error('[RecentGames] Erreur Supabase :', JSON.stringify(err));
            return message.reply(`❌ Erreur Supabase : \`${err?.message || err?.code || JSON.stringify(err)}\``);
        }

        if (games.length === 0) {
            return message.reply('📭 Aucun jeu trouvé dans la base de données.');
        }

        const totalPages = Math.ceil(games.length / ITEMS_PER_PAGE);
        let page = 0;

        // ID unique pour isoler les boutons de cette session
        const uid = `${message.author.id}_${Date.now()}`;

        const reply = await message.reply({
            embeds: [buildEmbed(games, page, totalPages, games.length)],
            components: totalPages > 1 ? [buildRow(page, totalPages, uid)] : [],
        });

        if (totalPages <= 1) return; // pas besoin de collector

        // ─── Collector de boutons ──────────────────────────────────────────────
        const collector = reply.createMessageComponentCollector({
            filter: (i) => {
                // Seul l'auteur de la commande peut paginer
                if (i.user.id !== message.author.id) {
                    i.reply({ content: '❌ Seul celui qui a lancé la commande peut naviguer.', ephemeral: true });
                    return false;
                }
                return i.customId.endsWith(uid);
            },
            time: TIMEOUT_MS,
        });

        collector.on('collect', async (interaction) => {
            if (interaction.customId === `recents_prev_${uid}`) page = Math.max(0, page - 1);
            if (interaction.customId === `recents_next_${uid}`) page = Math.min(totalPages - 1, page + 1);

            await interaction.update({
                embeds: [buildEmbed(games, page, totalPages, games.length)],
                components: [buildRow(page, totalPages, uid)],
            });
        });

        collector.on('end', async () => {
            // Désactive les boutons à l'expiration
            try {
                const disabledRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`recents_prev_${uid}_expired`)
                        .setLabel('◀ Précédent')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`recents_page_${uid}_expired`)
                        .setLabel(`${page + 1} / ${totalPages}`)
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`recents_next_${uid}_expired`)
                        .setLabel('Suivant ▶')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                );
                await reply.edit({ components: [disabledRow] });
            } catch {}
        });
    });
};
