# 🤖 DamnLoads Bot — Déploiement Railway

## Pourquoi Railway ?
Vercel est **serverless** : impossible d'y faire tourner un bot Discord qui a besoin d'une connexion WebSocket permanente. Railway héberge un vrai process Node.js en continu, gratuitement (500h/mois sur le plan Hobby).

---

## 📋 Étape 1 — Table Supabase à créer

Avant de déployer, exécute ce SQL dans ton éditeur Supabase :

```sql
-- Table pour persister l'état du bot (remplace notifier-state.json)
create table if not exists bot_state (
  key   text primary key,
  value text not null
);

insert into bot_state (key, value)
values ('lastSeenId', '0')
on conflict do nothing;
```

---

## 🚀 Étape 2 — Déployer sur Railway

### Option A — Via GitHub (recommandé)

1. Push ce dossier `railway-bot/` sur un **repo GitHub privé**
2. Va sur [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Sélectionne ton repo
4. Railway détecte automatiquement Node.js et lance `npm start`

### Option B — Via CLI Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## ⚙️ Étape 3 — Variables d'environnement

Dans Railway → ton service → onglet **Variables**, ajoute :

| Variable | Valeur | Obligatoire |
|---|---|---|
| `DISCORD_TOKEN` | Token du bot Discord | ✅ |
| `DISCORD_CLIENT_ID` | ID de l'application Discord | ✅ |
| `DISCORD_GUILD_ID` | ID de ton serveur Discord | ✅ |
| `SUPABASE_URL` | URL de ton projet Supabase | ✅ |
| `SUPABASE_KEY` | Clé `anon` ou `service_role` Supabase | ✅ |
| `SITE_URL` | `https://damnloads.com` | ✅ |
| `BOT_SECRET` | Secret partagé avec Vercel | ✅ |
| `ROLE_ID_HOARDER` | ID du rôle Hoarder 👑 | Pour role-sync |
| `ROLE_ID_COLLECTOR` | ID du rôle Collector 💎 | Pour role-sync |
| `ROLE_ID_DOWNLOADER` | ID du rôle Downloader ⬇️ | Pour role-sync |
| `NEW_GAME_CHANNEL_ID` | ID du salon d'annonces | Pour game notifier |
| `POLL_INTERVAL_GAMES` | `120000` (2 min) | Optionnel |

> **Note :** Ne pas définir `PORT` manuellement — Railway l'injecte automatiquement.

---

## 📁 Fichiers inclus

```
railway-bot/
├── gemini-code-1777201749527.js   ← Bot principal
├── role-sync.js                   ← Sync des rôles selon téléchargements
├── new-game-notifier.js           ← Annonces des nouveaux jeux
├── notifier-state.js              ← État persistant via Supabase (plus de fichier JSON)
├── recent-games.js                ← Commande !recents
├── stats.js                       ← Stats téléchargements
├── package.json                   ← Dépendances + script start
├── railway.json                   ← Config Railway
├── .env.example                   ← Toutes les variables à remplir
└── .gitignore                     ← Exclut node_modules, .env, etc.
```

---

## 🔄 Différences vs version locale

| | Local (PC) | Railway |
|---|---|---|
| `notifier-state.json` | Fichier local | ❌ Remplacé par table `bot_state` Supabase |
| Redémarrage | Manuel | Automatique (Railway relance en cas de crash) |
| Disponibilité | Quand le PC est allumé | 24/7 |
| `giveaways.json` | Fichier local | ⚠️ Voir note ci-dessous |

### ⚠️ Note sur `giveaways.json`
Les giveaways actifs sont sauvegardés dans un fichier JSON local. Sur Railway, ce fichier **disparaît si le service redémarre**. Si les giveaways sont importants, il faudra également les migrer vers Supabase (table `giveaways`). Pour l'instant ils se réinitialisent au redémarrage.

---

## 🐛 Debug

Voir les logs en temps réel :
- Railway → ton service → onglet **Logs**
- Ou via CLI : `railway logs`

---

## 💰 Coût

Railway offre **500h gratuites/mois** sur le plan Starter (sans carte bancaire). Un bot Discord tourne en continu = 720h/mois → il faut le **plan Hobby à 5$/mois** pour une disponibilité 24/7 sans interruption.

Alternative gratuite : [Render.com](https://render.com) (free tier avec quelques limitations de sleep).
