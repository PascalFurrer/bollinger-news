'use strict';
const express = require('express');
const { Pool } = require('pg');
const multer  = require('multer');
const sharp   = require('sharp');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20, fieldSize: 5 * 1024 * 1024 }
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 8) {
  console.error('FATAL: ADMIN_TOKEN env variable missing or too short (min 8 chars)');
  process.exit(1);
}

// Railway runs behind a proxy — needed for correct client IPs (rate limiting)
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── CORS: only the website may call the API from a browser ──
const ALLOWED_ORIGINS = [
  'https://www.bollinger-badmanufaktur.de',
  'https://bollinger-badmanufaktur.de',
  'http://www.bollinger-badmanufaktur.de',
  'http://bollinger-badmanufaktur.de',
];
app.use(cors({
  origin(origin, cb) {
    // Allow requests without Origin (curl, server-to-server, same-origin)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true); // local dev
    cb(null, false);
  }
}));

app.use(express.json({ limit: '2mb' }));

// ── Security headers ──
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

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

// ── Auth: timing-safe token comparison ──
function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (tokenMatches(token)) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
}

// ── Login rate limiting: max 10 attempts per 15 min per IP ──
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;

function loginRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > LOGIN_WINDOW_MS) { entry.count = 0; entry.start = now; }
  if (entry.count >= LOGIN_MAX) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.' });
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  next();
}
// Cleanup stale entries hourly
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) if (now - e.start > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
}, 60 * 60 * 1000).unref();

// ── Helpers ──
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

// Validate and trim text inputs; returns null on violation
function cleanText(val, maxLen) {
  if (val === undefined || val === null) return '';
  if (typeof val !== 'string') return null;
  const s = val.trim();
  return s.length <= maxLen ? s : null;
}

function serverError(res, err, ctx) {
  console.error(`[${ctx}]`, err);
  res.status(500).json({ error: 'Interner Fehler' });
}

// ══════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════

// All published posts (first image as cover)
app.get('/posts', async (req, res) => {
  try {
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
  } catch (err) { serverError(res, err, 'GET /posts'); }
});

// Sitemap of all published posts (referenced in the website's robots.txt)
app.get('/sitemap.xml', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT slug, published_at, updated_at FROM posts WHERE published=TRUE ORDER BY published_at DESC`
    );
    const urls = r.rows.map(p => {
      const lastmod = new Date(p.updated_at || p.published_at).toISOString().slice(0, 10);
      return `  <url>\n    <loc>https://www.bollinger-badmanufaktur.de/post.html?slug=${encodeURIComponent(p.slug)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    }).join('\n');
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
    );
  } catch (err) { serverError(res, err, 'GET /sitemap.xml'); }
});

// Single post by slug (with all images)
app.get('/posts/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug).slice(0, 255);
    const r = await pool.query(
      `SELECT id, slug, title, summary, body, image_base64, image_mime, published_at
       FROM posts WHERE slug=$1 AND published=TRUE`,
      [slug]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    const post = r.rows[0];
    const imgs = await pool.query(
      `SELECT id, image_base64, image_mime FROM post_images WHERE post_id=$1 ORDER BY sort_order ASC`,
      [post.id]
    );
    post.images = imgs.rows;
    res.json(post);
  } catch (err) { serverError(res, err, 'GET /posts/:slug'); }
});

// ══════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════

app.post('/admin/login', loginRateLimit, (req, res) => {
  const { token } = req.body || {};
  if (tokenMatches(token)) return res.json({ ok: true });
  res.status(401).json({ error: 'Falsches Passwort' });
});

// List all posts (incl. drafts)
app.get('/admin/posts', requireAdmin, async (req, res) => {
  try {
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
  } catch (err) { serverError(res, err, 'GET /admin/posts'); }
});

// Get single post (admin, includes body)
app.get('/admin/posts/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const r = await pool.query('SELECT * FROM posts WHERE id=$1', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    const post = r.rows[0];
    const imgs = await pool.query(
      `SELECT id, image_base64, image_mime FROM post_images WHERE post_id=$1 ORDER BY sort_order ASC`,
      [post.id]
    );
    post.images = imgs.rows;
    res.json(post);
  } catch (err) { serverError(res, err, 'GET /admin/posts/:id'); }
});

// Create post
app.post('/admin/posts', requireAdmin, upload.array('images', 20), async (req, res) => {
  try {
    const title   = cleanText(req.body.title, 300);
    const summary = cleanText(req.body.summary, 1000);
    const body    = cleanText(req.body.body, 2 * 1024 * 1024);
    if (title === null || summary === null || body === null) {
      return res.status(400).json({ error: 'Eingabe zu lang' });
    }
    if (!title) return res.status(400).json({ error: 'Titel erforderlich' });
    const slug = toSlug(title);
    const pub = req.body.published === 'true' || req.body.published === true;

    // Legacy single cover image (first uploaded image goes to posts table too for compat)
    let image_base64 = null, image_mime = 'image/jpeg';
    if (req.files && req.files.length > 0) {
      image_base64 = await compressImage(req.files[0].buffer);
    }

    const r = await pool.query(
      `INSERT INTO posts (slug, title, summary, body, image_base64, image_mime, published, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [slug, title, summary, body, image_base64, image_mime, pub, pub ? new Date() : null]
    );
    const postId = r.rows[0].id;

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
  } catch (err) { serverError(res, err, 'POST /admin/posts'); }
});

// Update post
app.put('/admin/posts/:id', requireAdmin, upload.array('images', 20), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const title   = cleanText(req.body.title, 300);
    const summary = cleanText(req.body.summary, 1000);
    const body    = cleanText(req.body.body, 2 * 1024 * 1024);
    if (title === null || summary === null || body === null) {
      return res.status(400).json({ error: 'Eingabe zu lang' });
    }
    const pub = req.body.published === 'true' || req.body.published === true;

    const existing = await pool.query('SELECT * FROM posts WHERE id=$1', [id]);
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
      [title || cur.title, summary || cur.summary, body || cur.body,
       image_base64, image_mime, pub, pub_at, id]
    );

    // Append new images
    if (req.files && req.files.length > 0) {
      const countRes = await pool.query('SELECT COUNT(*) FROM post_images WHERE post_id=$1', [id]);
      let sortStart = parseInt(countRes.rows[0].count);
      for (let i = 0; i < req.files.length; i++) {
        const b64 = await compressImage(req.files[i].buffer);
        await pool.query(
          `INSERT INTO post_images (post_id, image_base64, image_mime, sort_order) VALUES ($1,$2,$3,$4)`,
          [id, b64, 'image/jpeg', sortStart + i]
        );
      }
    }

    res.json({ ok: true });
  } catch (err) { serverError(res, err, 'PUT /admin/posts/:id'); }
});

// Delete post
app.delete('/admin/posts/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    await pool.query('DELETE FROM posts WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (err) { serverError(res, err, 'DELETE /admin/posts/:id'); }
});

// Delete cover image
app.delete('/admin/posts/:id/image', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    await pool.query('UPDATE posts SET image_base64=NULL WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (err) { serverError(res, err, 'DELETE /admin/posts/:id/image'); }
});

// Delete single gallery image
app.delete('/admin/images/:imageId', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.imageId, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    await pool.query('DELETE FROM post_images WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (err) { serverError(res, err, 'DELETE /admin/images/:imageId'); }
});

// Multer/misc error handler (e.g. file too large) — keep messages generic
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Upload abgelehnt (Datei zu gross oder zu viele Dateien)' });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`News API on :${PORT}`));
