'use strict';
const express = require('express');
const { Pool } = require('pg');
const multer  = require('multer');
const sharp   = require('sharp');
const cors    = require('cors');

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_images (
      id          SERIAL PRIMARY KEY,
      post_id     INT REFERENCES posts(id) ON DELETE CASCADE,
      image_base64 TEXT NOT NULL,
      image_mime  VARCHAR(50) DEFAULT 'image/jpeg',
      sort_order  INT DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
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

async function compressImage(buffer) {
  const buf = await sharp(buffer).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return buf.toString('base64');
}

// ══════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════

// All published posts (first image as cover)
app.get('/posts', async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.slug, p.title, p.summary, p.image_base64, p.image_mime, p.published_at,
            (SELECT pi.image_base64 FROM post_images pi WHERE pi.post_id=p.id ORDER BY pi.sort_order ASC LIMIT 1) AS gallery_cover,
            (SELECT pi.image_mime   FROM post_images pi WHERE pi.post_id=p.id ORDER BY pi.sort_order ASC LIMIT 1) AS gallery_cover_mime
     FROM posts p WHERE p.published=TRUE ORDER BY p.published_at DESC`
  );
  const rows = r.rows.map(p => ({
    ...p,
    cover_base64: p.gallery_cover || p.image_base64,
    cover_mime:   p.gallery_cover_mime || p.image_mime,
  }));
  res.json(rows);
});

// Single post by slug (with all images)
app.get('/posts/:slug', async (req, res) => {
  const r = await pool.query(
    `SELECT id, slug, title, summary, body, image_base64, image_mime, published_at
     FROM posts WHERE slug=$1 AND published=TRUE`,
    [req.params.slug]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  const post = r.rows[0];
  const imgs = await pool.query(
    `SELECT id, image_base64, image_mime FROM post_images WHERE post_id=$1 ORDER BY sort_order ASC`,
    [post.id]
  );
  post.images = imgs.rows;
  res.json(post);
});

// ══════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════

app.post('/admin/login', (req, res) => {
  const { token } = req.body;
  if (token === ADMIN_TOKEN) return res.json({ ok: true });
  res.status(401).json({ error: 'Falsches Passwort' });
});

// List all posts (incl. drafts)
app.get('/admin/posts', requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.slug, p.title, p.summary, p.published, p.published_at, p.created_at,
            p.image_base64, p.image_mime,
            array_agg(json_build_object('id', pi.id, 'image_base64', pi.image_base64, 'image_mime', pi.image_mime, 'sort_order', pi.sort_order) ORDER BY pi.sort_order)
              FILTER (WHERE pi.id IS NOT NULL) AS images
     FROM posts p
     LEFT JOIN post_images pi ON pi.post_id = p.id
     GROUP BY p.id
     ORDER BY p.created_at DESC`
  );
  res.json(r.rows);
});

// Get single post (admin, includes body)
app.get('/admin/posts/:id', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  const post = r.rows[0];
  const imgs = await pool.query(
    `SELECT id, image_base64, image_mime FROM post_images WHERE post_id=$1 ORDER BY sort_order ASC`,
    [post.id]
  );
  post.images = imgs.rows;
  res.json(post);
});

// Create post
app.post('/admin/posts', requireAdmin, upload.array('images', 20), async (req, res) => {
  try {
    const { title, summary, body, published } = req.body;
    if (!title) return res.status(400).json({ error: 'Titel erforderlich' });
    const slug = toSlug(title);
    const pub = published === 'true' || published === true;

    // Legacy single cover image (first uploaded image goes to posts table too for compat)
    let image_base64 = null, image_mime = 'image/jpeg';
    if (req.files && req.files.length > 0) {
      image_base64 = await compressImage(req.files[0].buffer);
    }

    const r = await pool.query(
      `INSERT INTO posts (slug, title, summary, body, image_base64, image_mime, published, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [slug, title, summary || '', body || '', image_base64, image_mime, pub, pub ? new Date() : null]
    );
    const postId = r.rows[0].id;

    // Save all images to post_images
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const b64 = await compressImage(req.files[i].buffer);
        await pool.query(
          `INSERT INTO post_images (post_id, image_base64, image_mime, sort_order) VALUES ($1,$2,$3,$4)`,
          [postId, b64, 'image/jpeg', i]
        );
      }
    }

    res.json({ ok: true, post: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update post
app.put('/admin/posts/:id', requireAdmin, upload.array('images', 20), async (req, res) => {
  try {
    const { title, summary, body, published } = req.body;
    const pub = published === 'true' || published === true;
    const existing = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    const cur = existing.rows[0];

    let image_base64 = cur.image_base64, image_mime = cur.image_mime;
    if (req.files && req.files.length > 0) {
      image_base64 = await compressImage(req.files[0].buffer);
      image_mime = 'image/jpeg';
    }

    const pub_at = pub ? (cur.published_at || new Date()) : null;
    await pool.query(
      `UPDATE posts SET title=$1, summary=$2, body=$3, image_base64=$4, image_mime=$5,
       published=$6, published_at=$7, updated_at=NOW() WHERE id=$8`,
      [title || cur.title, summary ?? cur.summary, body ?? cur.body,
       image_base64, image_mime, pub, pub_at, req.params.id]
    );

    // Append new images
    if (req.files && req.files.length > 0) {
      const countRes = await pool.query('SELECT COUNT(*) FROM post_images WHERE post_id=$1', [req.params.id]);
      let sortStart = parseInt(countRes.rows[0].count);
      for (let i = 0; i < req.files.length; i++) {
        const b64 = await compressImage(req.files[i].buffer);
        await pool.query(
          `INSERT INTO post_images (post_id, image_base64, image_mime, sort_order) VALUES ($1,$2,$3,$4)`,
          [req.params.id, b64, 'image/jpeg', sortStart + i]
        );
      }
    }

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

// Delete cover image
app.delete('/admin/posts/:id/image', requireAdmin, async (req, res) => {
  await pool.query('UPDATE posts SET image_base64=NULL WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Delete single gallery image
app.delete('/admin/images/:imageId', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM post_images WHERE id=$1', [req.params.imageId]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`News API on :${PORT}`));
