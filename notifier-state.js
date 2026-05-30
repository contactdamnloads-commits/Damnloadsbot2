// ─── notifier-state.js ───────────────────────────────────────────────────────
// Remplace la persistance fichier (notifier-state.json) par Supabase.
// Railway a un filesystem éphémère : le fichier JSON disparaît à chaque
// redéploiement. On stocke le lastSeenId dans une table Supabase à la place.
//
// Table Supabase à créer (SQL) :
//   create table if not exists bot_state (
//     key   text primary key,
//     value text not null
//   );
//   insert into bot_state (key, value) values ('lastSeenId', '0')
//   on conflict do nothing;
// ─────────────────────────────────────────────────────────────────────────────

let _supabase = null;
const TABLE   = 'bot_state';
const KEY     = 'lastSeenId';

// Fallback mémoire si Supabase échoue
let _memoryState = { lastSeenId: 0 };

function init(supabaseClient) {
    _supabase = supabaseClient;
}

async function loadState() {
    if (!_supabase) return { ..._memoryState };
    try {
        const { data, error } = await _supabase
            .from(TABLE)
            .select('value')
            .eq('key', KEY)
            .single();

        if (error || !data) {
            console.warn('[NotifierState] Impossible de lire depuis Supabase, utilise la mémoire :', error?.message);
            return { ..._memoryState };
        }

        const lastSeenId = parseInt(data.value) || 0;
        _memoryState = { lastSeenId };
        return { lastSeenId };
    } catch (err) {
        console.error('[NotifierState] Erreur loadState :', err.message);
        return { ..._memoryState };
    }
}

async function saveState(state) {
    _memoryState = { ...state };

    if (!_supabase) return;
    try {
        const { error } = await _supabase
            .from(TABLE)
            .upsert({ key: KEY, value: String(state.lastSeenId) });

        if (error) {
            console.warn('[NotifierState] Impossible de sauvegarder dans Supabase :', error.message);
        }
    } catch (err) {
        console.error('[NotifierState] Erreur saveState :', err.message);
    }
}

module.exports = { init, loadState, saveState };
