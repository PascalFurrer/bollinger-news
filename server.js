'use strict';
const express = require('express');
const { Pool } = require('pg');
const multer  = require('multer');
const sharp   = require('sharp');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── DB init ──
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id          SERIAL PRIMARY KEY,
      slug        VARCHAR(255) UNIQUE NOT NULL,
      title       TEXT NOT NULL,
      summary     TEXT,
      body        TEXT,
      image_base64 TEXT,
      image_mime  VARCHAR(50) DEFAULT 'image/jpeg',
      published   BOOLEAN DEFAULT FALSE,
      published_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB ready');
}
initDb().catch(console.error);

// ── Auth middleware ──
function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${ADMIN_TOKEN}`) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
}

// ── Slug helper ──
function toSlug(title) {
  return title.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    + '-' + Date.now().toString(36);
}

// ══════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════

// All published posts (no body/image to keep payload small)
app.get('/posts', async (req, res) => {
  const r = await pool.query(
    `SELECT id, slug, title, summary, image_base64, image_mime, published_at
     FROM posts WHERE published=TRUE ORDER BY published_at DESC`
  );
  res.json(r.rows);
});

// Single post by slug
app.get('/posts/:slug', async (req, res) => {
  const r = await pool.query(
    `SELECT id, slug, title, summary, body, image_base64, image_mime, published_at
     FROM posts WHERE slug=$1 AND published=TRUE`,
    [req.params.slug]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(r.rows[0]);
});

// ══════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════

// Login check
app.post('/admin/login', (req, res) => {
  const { token } = req.body;
  if (token === ADMIN_TOKEN) return res.json({ ok: true });
  res.status(401).json({ error: 'Falsches Passwort' });
});

// List all posts (incl. drafts)
app.get('/admin/posts', requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, slug, title, summary, published, published_at, created_at FROM posts ORDER BY created_at DESC`
  );
  res.json(r.rows);
});

// Create post
app.post('/admin/posts', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, summary, body, published } = req.body;
    if (!title) return res.status(400).json({ error: 'Titel erforderlich' });
    const slug = toSlug(title);
    let image_base64 = null, image_mime = 'image/jpeg';
    if (req.file) {
      const buf = await sharp(req.file.buffer).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      image_base64 = buf.toString('base64');
    }
    const pub = published === 'true' || published === true;
    const r = await pool.query(
      `INSERT INTO posts (slug, title, summary, body, image_base64, image_mime, published, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [slug, title, summary || '', body || '', image_base64, image_mime, pub, pub ? new Date() : null]
    );
    res.json({ ok: true, post: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update post
app.put('/admin/posts/:id', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, summary, body, published } = req.body;
    const pub = published === 'true' || published === true;
    const existing = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    const cur = existing.rows[0];
    let image_base64 = cur.image_base64, image_mime = cur.image_mime;
    if (req.file) {
      const buf = await sharp(req.file.buffer).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      image_base64 = buf.toString('base64');
      image_mime = 'image/jpeg';
    }
    const pub_at = pub ? (cur.published_at || new Date()) : null;
    await pool.query(
      `UPDATE posts SET title=$1, summary=$2, body=$3, image_base64=$4, image_mime=$5,
       published=$6, published_at=$7, updated_at=NOW() WHERE id=$8`,
      [title || cur.title, summary ?? cur.summary, body ?? cur.body,
       image_base64, image_mime, pub, pub_at, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete post
app.delete('/admin/posts/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Delete image from post
app.delete('/admin/posts/:id/image', requireAdmin, async (req, res) => {
  await pool.query('UPDATE posts SET image_base64=NULL WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`News API on :${PORT}`));
