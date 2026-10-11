const express = require('express');
const { pool } = require('../lib/db');
const { wrap } = require('../lib/http');
const { requireAuth, requireRoles } = require('../lib/auth');

const router = express.Router();

router.use(requireAuth, requireRoles(['admin', 'owner', 'finance']));

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.username
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT 100`
  );
  res.render('audit', { logs: rows });
}));

module.exports = router;