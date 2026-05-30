// ─── role-sync.js ─────────────────────────────────────────────────────────────
// Ajoute ce fichier à côté de ton bot principal (gemini-code-*.js)
// et require-le dans ton bot : require('./role-sync')(client)
//
// Ce module gère :
//  - La synchronisation des rôles au démarrage du bot
//  - Une commande slash /sync pour relancer la sync manuellement
//  - Un polling automatique toutes les X minutes
// ──────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

// ─── Configuration des grades ─────────────────────────────────────────────────
// Modifie les IDs de rôles et les seuils selon ton serveur Discord
// Ordre décroissant : le plus haut grade est vérifié en premier
const GRADES = [
  {
    label: "Hoarder 👑",
    roleId: process.env.ROLE_ID_HOARDER,    // ex: "123456789012345678"
    min: 100,
  },
  {
    label: "Collector 💎",
    roleId: process.env.ROLE_ID_COLLECTOR,  // ex: "234567890123456789"
    min: 25,
  },
  {
    label: "Downloader ⬇️",
    roleId: process.env.ROLE_ID_DOWNLOADER, // ex: "345678901234567890"
    min: 5,
  },
];

const SITE_URL = process.env.SITE_URL;         // ex: https://damnloads-vault.vercel.app
const BOT_SECRET = process.env.BOT_SECRET;     // même valeur que dans Vercel
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const POLL_INTERVAL_MS = 5 * 60 * 1000;       // sync toutes les 5 minutes

// ─── Utilitaires ──────────────────────────────────────────────────────────────

// Retourne le grade correspondant à un nombre de téléchargements
function resolveGrade(count) {
  for (const grade of GRADES) {
    if (count >= grade.min && grade.roleId) return grade;
  }
  return null;
}

// Tous les IDs de rôles de grade (pour pouvoir retirer les anciens)
function allGradeRoleIds() {
  return GRADES.map((g) => g.roleId).filter(Boolean);
}

// Récupère la DB de téléchargements depuis le site
async function fetchDownloadsDB() {
  const res = await fetch(`${SITE_URL}/api/get-downloads`, {
    headers: { "x-bot-secret": BOT_SECRET },
  });
  if (!res.ok) throw new Error(`Erreur HTTP ${res.status} sur get-downloads`);
  return res.json(); // { users: { discord_id: { total, username, downloads: [] } }, last_updated }
}

// ─── Synchronisation principale ───────────────────────────────────────────────
async function syncRoles(client, verbose = false) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    // Le fetch des membres est déjà fait au démarrage dans gemini-code — on utilise le cache

    
    const db = await fetchDownloadsDB();
    const users = db.users || {};

    let assigned = 0;
    let removed = 0;
    let skipped = 0;

    for (const [discordId, userData] of Object.entries(users)) {
      let member;
      try {
        member = await guild.members.fetch(discordId);
      } catch {
        // L'utilisateur n'est plus dans le serveur
        skipped++;
        continue;
      }

      const targetGrade = resolveGrade(userData.total);
      const allGradeIds = allGradeRoleIds();

      // Retire tous les rôles de grade existants
      for (const roleId of allGradeIds) {
        if (member.roles.cache.has(roleId)) {
          try {
            await member.roles.remove(roleId);
            removed++;
          } catch (e) {
            console.warn(`⚠️ Impossible de retirer le rôle ${roleId} à ${discordId}:`, e.message);
          }
        }
      }

      // Assigne le bon rôle si un grade est atteint
      if (targetGrade) {
        try {
          await member.roles.add(targetGrade.roleId);
          assigned++;
          if (verbose) {
            console.log(`✅ ${userData.username} → ${targetGrade.label} (${userData.total} DLs)`);
          }
        } catch (e) {
          console.warn(`⚠️ Impossible d'assigner ${targetGrade.label} à ${discordId}:`, e.message);
        }
      }
    }

    console.log(`[RoleSync] Terminé : ${assigned} assignés, ${removed} retirés, ${skipped} absents du serveur`);
    return { assigned, removed, skipped, total: Object.keys(users).length };
  } catch (err) {
    console.error("[RoleSync] Erreur lors de la synchronisation :", err.message);
    throw err;
  }
}

// ─── Export du module ─────────────────────────────────────────────────────────
module.exports = function setupRoleSync(client) {

  // Sync au démarrage du bot
  client.once("clientReady", async () => {
    console.log("[RoleSync] Bot prêt — synchronisation des rôles au démarrage...");
    try {
      await syncRoles(client, true);
    } catch (e) {
      console.error("[RoleSync] Echec de la sync au démarrage :", e.message);
    }

    // Polling automatique toutes les 5 minutes
    setInterval(async () => {
      console.log("[RoleSync] Sync automatique...");
      try {
        await syncRoles(client, false);
      } catch (e) {
        console.error("[RoleSync] Echec de la sync automatique :", e.message);
      }
    }, POLL_INTERVAL_MS);
  });

  // Commande slash /sync (pour les admins)
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "sync") return;

    // Vérifie que l'utilisateur a la permission admin
    if (!interaction.memberPermissions?.has("Administrator")) {
      return interaction.reply({ content: "❌ Tu n'as pas la permission.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await syncRoles(client, true);
      await interaction.editReply(
        `✅ Sync terminée !\n` +
        `• **${result.assigned}** rôles assignés\n` +
        `• **${result.removed}** rôles retirés\n` +
        `• **${result.skipped}** utilisateurs absents du serveur\n` +
        `• **${result.total}** utilisateurs dans la DB`
      );
    } catch (err) {
      await interaction.editReply(`❌ Erreur lors de la sync : ${err.message}`);
    }
  });
};

// ─── Enregistrement de la commande slash /sync ────────────────────────────────
// Lance ce script UNE SEULE FOIS pour enregistrer la commande :
//   node role-sync.js --register
if (process.argv.includes("--register")) {
  const { REST, Routes, SlashCommandBuilder } = require("discord.js");
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const command = new SlashCommandBuilder()
    .setName("sync")
    .setDescription("Synchronise les rôles de grade selon les téléchargements");

  rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID), {
    body: [command.toJSON()],
  }).then(() => {
    console.log("✅ Commande /sync enregistrée !");
    process.exit(0);
  }).catch((e) => {
    console.error("❌ Erreur :", e.message);
    process.exit(1);
  });
}
