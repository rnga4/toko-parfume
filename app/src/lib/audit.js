async function logActivity(pool, user, action, entity, entityId, detail) {
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [user && user.id, action, entity, entityId, detail || null]
  );
}

module.exports = { logActivity };