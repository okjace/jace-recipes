// In-app notifications (the 🔔 inbox), like Jace Design's.
// Types:
//   invite        someone invited you to make a recipe with them (Accept / Decline)
//   invite_accepted, comment, approved, verified, taken_down, restored, role
//   review        (admin) something is waiting for review
//   blocked       (admin) auto moderation blocked a recipe
import { randomUUID } from 'node:crypto';
import { query, one } from './db.js';

/** Adds a notification. Never throws; never notifies people about their own actions. */
export async function notify(userSub, { type, recipeId = null, actorSub = null, data = {} }) {
  if (!userSub || (actorSub && actorSub === userSub)) return;
  try {
    // One invite per recipe: refresh instead of stacking.
    if (type === 'invite' && recipeId) await query("DELETE FROM notifications WHERE user_sub = $1 AND type = 'invite' AND recipe_id = $2", [userSub, recipeId]);
    await query('INSERT INTO notifications (id, user_sub, type, recipe_id, actor_sub, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), userSub, type, recipeId, actorSub, JSON.stringify(data || {}), Date.now()]);
    // Keep inboxes tidy: only the newest 200.
    await query(`DELETE FROM notifications WHERE user_sub = $1 AND id NOT IN (
      SELECT id FROM notifications WHERE user_sub = $1 ORDER BY created_at DESC LIMIT 200)`, [userSub]);
  } catch (e) {
    console.warn(`[notify] ${type} failed: ${e.message}`);
  }
}

export const clearInvite = (userSub, recipeId) =>
  query("DELETE FROM notifications WHERE user_sub = $1 AND type = 'invite' AND recipe_id = $2", [userSub, recipeId]).catch(() => {});

export async function inbox(userSub) {
  const rows = await query(`SELECT n.*, a.username AS actor_username, a.display_name AS actor_name, a.avatar_url AS actor_avatar,
      r.title AS recipe_title, r.image_url AS recipe_image, r.category AS recipe_category
    FROM notifications n
    LEFT JOIN users a ON a.sub = n.actor_sub
    LEFT JOIN recipes r ON r.id = n.recipe_id
    WHERE n.user_sub = $1
      -- invites only while they're still open
      AND NOT (n.type = 'invite' AND NOT EXISTS (SELECT 1 FROM collaborators k WHERE k.recipe_id = n.recipe_id AND k.sub = n.user_sub AND k.status = 'invited'))
    ORDER BY n.created_at DESC LIMIT 100`, [userSub]);
  return rows.map((n) => ({
    id: n.id, type: n.type, recipeId: n.recipe_id, recipeTitle: n.recipe_title, recipeImage: n.recipe_image, recipeCategory: n.recipe_category,
    actor: n.actor_sub ? { username: n.actor_username, displayName: n.actor_name, avatar: n.actor_avatar } : null,
    data: n.data || {}, read: Boolean(n.read_at), createdAt: Number(n.created_at),
  }));
}

export async function unreadCount(userSub) {
  const row = await one(`SELECT COUNT(*)::int AS n FROM notifications n WHERE n.user_sub = $1 AND n.read_at IS NULL
    AND NOT (n.type = 'invite' AND NOT EXISTS (SELECT 1 FROM collaborators k WHERE k.recipe_id = n.recipe_id AND k.sub = n.user_sub AND k.status = 'invited'))`, [userSub]);
  return row?.n || 0;
}
