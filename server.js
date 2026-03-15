const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3006;
const FDA_BASE = 'https://api.fda.gov/food/enforcement.json';

// 30-minute cache
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

async function fdaFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FDA API error ${response.status}: ${text}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// GET /api/recalls — recent active recalls, last 90 days
app.get('/api/recalls', async (req, res) => {
  const cacheKey = 'recent_recalls';
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Calculate date 90 days ago
    const now = new Date();
    const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const fmt = (d) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

    const startDate = fmt(past);
    const endDate = fmt(now);

    const url = `${FDA_BASE}?search=report_date:[${startDate}+TO+${endDate}]+AND+status:"Ongoing"&limit=20&sort=report_date:desc`;
    const data = await fdaFetch(url);

    const result = {
      total: data.meta?.results?.total || 0,
      results: data.results || [],
    };

    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'FDA API timeout' });
    }
    // If no results found (404 from OpenFDA means empty), return empty
    if (err.message.includes('404')) {
      const empty = { total: 0, results: [] };
      setCached(cacheKey, empty);
      return res.json(empty);
    }
    console.error('Error fetching recalls:', err.message);
    res.status(500).json({ error: 'Failed to fetch recalls', detail: err.message });
  }
});

// GET /api/search?q=TERM — search recalls by product or brand
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  const cacheKey = `search_${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Search product_description and recalling_firm for the term
    const encoded = encodeURIComponent(q);
    const url = `${FDA_BASE}?search=(product_description:"${encoded}"+recalling_firm:"${encoded}")&limit=20&sort=report_date:desc`;
    const data = await fdaFetch(url);

    const result = {
      total: data.meta?.results?.total || 0,
      results: data.results || [],
      query: q,
    };

    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'FDA API timeout' });
    }
    if (err.message.includes('404')) {
      const empty = { total: 0, results: [], query: q };
      setCached(cacheKey, empty);
      return res.json(empty);
    }
    console.error('Error searching recalls:', err.message);
    res.status(500).json({ error: 'Failed to search recalls', detail: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Food Recalls server running on http://localhost:${PORT}`);
  });
}
