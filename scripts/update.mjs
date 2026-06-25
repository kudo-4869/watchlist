// scripts/update.mjs
// Run by GitHub Actions (daily cron + manual dispatch + add-item flow).
// Reads data/titles.json, enriches each entry via TVmaze (series/anime) + iTunes Search (movies)
// — both completely free with NO signup or API key required — diffs against the previous
// catalog.json to auto-detect delays/renewals/cancellations, scans Google News RSS for related
// news, classifies it by keyword, and writes the result to data/catalog.json.
//
// Env vars:
//   ONLY_ID - optional, limit processing to a single title id (used right after adding an item)

import fs from 'fs';

const ONLY_ID = process.env.ONLY_ID || null;

const TITLES_PATH = 'data/titles.json';
const CATALOG_PATH = 'data/catalog.json';

const STATUS_AR = { ongoing: 'مستمر', ended: 'منتهي', cancelled: 'ملغى', unknown: 'غير معروف' };

const SEASON_KEYWORDS = [
  'renew', 'season 2', 'season two', 'new season', 'next season',
  'cancel', 'canceled', 'cancelled', 'final season',
  'تجديد', 'إلغاء', 'الغاء', 'موسم جديد', 'موسم ثاني', 'موسم ثالث', 'موسم رابع'
];
const RELEASE_KEYWORDS = [
  'premiere', 'release date', 'delay', 'delayed', 'postponed', 'air date', 'drops on', 'schedule',
  'موعد العرض', 'تأجيل', 'تاجيل', 'تاريخ العرض', 'تاريخ الإصدار', 'الحلقة القادمة', 'يعرض في'
];

/* ---------- helpers ---------- */
function readJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}
function today() { return new Date().toISOString().slice(0, 10); }
function arStatus(s) { return STATUS_AR[s] || s || 'غير معروف'; }
function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
function stripCdata(s) {
  if (!s) return '';
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}
function classify(text) {
  const t = (text || '').toLowerCase();
  if (SEASON_KEYWORDS.some(k => t.includes(k))) return 'season_news';
  if (RELEASE_KEYWORDS.some(k => t.includes(k))) return 'release_news';
  return 'general_news';
}
function bigArtwork(url) {
  if (!url) return '';
  return url.replace(/\d+x\d+bb(\.\w+)$/, '600x600bb$1');
}

/* ---------- Google News RSS (free, no key, server-side so no CORS issue) ---------- */
async function fetchGoogleNewsRSS(query, hl, gl, ceid) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; watchlist-bot/1.0)' } });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.split('<item>').slice(1);
    return blocks.map(b => {
      const titleM = b.match(/<title>([\s\S]*?)<\/title>/);
      const linkM = b.match(/<link>([\s\S]*?)<\/link>/);
      const dateM = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const sourceM = b.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      return {
        title: stripCdata(titleM ? titleM[1] : ''),
        link: linkM ? linkM[1].trim() : '',
        pubDate: dateM ? dateM[1].trim() : '',
        source: stripCdata(sourceM ? sourceM[1] : '')
      };
    }).filter(it => it.title && it.link);
  } catch (e) {
    console.error('RSS fetch failed for', query, e.message);
    return [];
  }
}

/* ---------- TVmaze (series & anime, no key needed) ---------- */
async function tvmazeLookup(title) {
  try {
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}
async function tvmazeNextEpisode(id) {
  try {
    const res = await fetch(`https://api.tvmaze.com/shows/${id}?embed[]=nextepisode`);
    if (!res.ok) return null;
    const data = await res.json();
    return data._embedded && data._embedded.nextepisode ? data._embedded.nextepisode.airdate : null;
  } catch (e) { return null; }
}
async function tvmazeEpisodeCounts(id) {
  try {
    const res = await fetch(`https://api.tvmaze.com/shows/${id}/episodes`);
    if (!res.ok) return { seasons: null, episodes: null };
    const eps = await res.json();
    if (!Array.isArray(eps) || eps.length === 0) return { seasons: null, episodes: null };
    const seasons = Math.max(...eps.map(e => e.season || 1));
    return { seasons, episodes: eps.length };
  } catch (e) { return { seasons: null, episodes: null }; }
}
function mapTvmazeStatus(s) {
  const t = (s || '').toLowerCase();
  if (t.includes('ended')) return 'ended';
  if (t.includes('running')) return 'ongoing';
  return 'unknown';
}

/* ---------- iTunes Search (movies, no key needed) ---------- */
async function itunesLookupMovie(title, yearHint) {
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=movie&limit=8`);
    if (!res.ok) return null;
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) return null;
    if (yearHint) {
      const withYear = results.find(r => (r.releaseDate || '').startsWith(String(yearHint)));
      if (withYear) return withYear;
    }
    return results[0];
  } catch (e) { return null; }
}
async function itunesLongDescription(trackId) {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${trackId}`);
    if (!res.ok) return '';
    const data = await res.json();
    const r = (data.results || [])[0];
    return r ? (r.longDescription || r.shortDescription || '') : '';
  } catch (e) { return ''; }
}

/* ---------- per-item processing ---------- */
async function processItem(titleEntry, prev) {
  const { id, title, type, year_hint } = titleEntry;
  const news = { season_news: [], release_news: [], general_news: [] };

  const meta = {
    id,
    title,
    type,
    year: prev?.year || '',
    poster_url: prev?.poster_url || '',
    description: prev?.description || '',
    status: prev?.status || 'unknown',
    total_seasons: prev?.total_seasons || null,
    total_episodes: prev?.total_episodes || null,
    next_episode_date: prev?.next_episode_date || null
  };

  try {
    if (type === 'movie') {
      const found = await itunesLookupMovie(title, year_hint);
      if (found) {
        meta.title = found.trackName || title;
        meta.year = (found.releaseDate || '').slice(0, 4) || meta.year;
        meta.poster_url = bigArtwork(found.artworkUrl100) || meta.poster_url;
        const longDesc = await itunesLongDescription(found.trackId);
        meta.description = longDesc || found.longDescription || meta.description;
        // movies don't really have ongoing/cancelled status — leave as unknown unless previously set manually
      } else {
        console.log('No iTunes match for', title);
      }
    } else if (type === 'series' || type === 'anime') {
      let found = await tvmazeLookup(title);
      if (!found && type === 'anime') {
        // some anime are released as films rather than TV series — fall back to iTunes movies
        const movieFallback = await itunesLookupMovie(title, year_hint);
        if (movieFallback) {
          meta.title = movieFallback.trackName || title;
          meta.year = (movieFallback.releaseDate || '').slice(0, 4) || meta.year;
          meta.poster_url = bigArtwork(movieFallback.artworkUrl100) || meta.poster_url;
          meta.description = (await itunesLongDescription(movieFallback.trackId)) || meta.description;
        } else {
          console.log('No TVmaze or iTunes match for', title);
        }
      } else if (found) {
        meta.title = found.name || title;
        meta.year = (found.premiered || '').slice(0, 4) || meta.year;
        meta.poster_url = (found.image && (found.image.original || found.image.medium)) || meta.poster_url;
        meta.description = stripHtml(found.summary || '') || meta.description;
        meta.status = mapTvmazeStatus(found.status);
        const counts = await tvmazeEpisodeCounts(found.id);
        meta.total_seasons = counts.seasons || meta.total_seasons;
        meta.total_episodes = counts.episodes || meta.total_episodes;

        const newNextDate = await tvmazeNextEpisode(found.id);

        if (prev && prev.status && prev.status !== meta.status) {
          news.season_news.push({
            date: today(),
            summary: `تغيّرت حالة "${meta.title}" من ${arStatus(prev.status)} إلى ${arStatus(meta.status)}`,
            source: 'TVmaze'
          });
        }
        if (newNextDate && prev?.next_episode_date && newNextDate !== prev.next_episode_date) {
          news.release_news.push({
            date: today(),
            summary: `تغيّر موعد الحلقة القادمة من ${prev.next_episode_date} إلى ${newNextDate}`,
            source: 'TVmaze'
          });
        } else if (newNextDate && !prev?.next_episode_date) {
          news.release_news.push({
            date: today(),
            summary: `تم تحديد موعد الحلقة القادمة: ${newNextDate}`,
            source: 'TVmaze'
          });
        }
        meta.next_episode_date = newNextDate;
      } else {
        console.log('No TVmaze match for', title);
      }
    }
    // type === 'play' -> no automatic source, manual data only (set via local browser overrides)
  } catch (e) {
    console.error('Metadata lookup error for', title, e.message);
  }

  // Google News RSS — best effort, free, classified by keyword
  try {
    const [arItems, enItems] = await Promise.all([
      fetchGoogleNewsRSS(title, 'ar', 'SA', 'SA:ar'),
      fetchGoogleNewsRSS(title, 'en-US', 'US', 'US:en')
    ]);
    const merged = [...arItems, ...enItems];
    const seenLinks = new Set(prev?.seenLinks || []);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const it of merged) {
      if (seenLinks.has(it.link)) continue;
      const t = new Date(it.pubDate).getTime();
      if (isNaN(t) || t < cutoff) continue;
      seenLinks.add(it.link);
      const cat = classify(it.title);
      news[cat].push({ date: it.pubDate ? it.pubDate.slice(0, 16) : '', summary: it.title, source: it.source || 'Google News' });
    }
    meta.seenLinks = Array.from(seenLinks).slice(-250);
  } catch (e) {
    console.error('News merge error for', title, e.message);
    meta.seenLinks = prev?.seenLinks || [];
  }

  // merge with previous news, keep most recent 8 per category
  for (const cat of ['season_news', 'release_news', 'general_news']) {
    const prevList = (prev && prev.news && prev.news[cat]) || [];
    news[cat] = [...news[cat], ...prevList].slice(0, 8);
  }

  meta.news = news;
  meta.checkedAt = new Date().toISOString();
  return meta;
}

/* ---------- main ---------- */
async function main() {
  const titles = readJSON(TITLES_PATH, []);
  const prevCatalog = readJSON(CATALOG_PATH, { items: [] });
  const prevById = {};
  (prevCatalog.items || []).forEach(i => { prevById[i.id] = i; });

  const targets = ONLY_ID ? titles.filter(t => t.id === ONLY_ID) : titles;
  if (targets.length === 0) {
    console.log('Nothing to process.');
  }

  const results = [];
  for (const t of targets) {
    console.log('Processing:', t.title);
    const item = await processItem(t, prevById[t.id]);
    results.push(item);
    await new Promise(r => setTimeout(r, 350)); // be gentle with external APIs
  }

  let finalItems;
  if (ONLY_ID) {
    finalItems = (prevCatalog.items || []).filter(i => i.id !== ONLY_ID);
    finalItems.push(...results);
  } else {
    // full run: drop any catalog items whose title entry no longer exists (i.e. removed from titles.json)
    finalItems = results;
  }

  writeJSON(CATALOG_PATH, { updatedAt: new Date().toISOString(), items: finalItems });
  console.log(`Done. ${results.length} item(s) processed, ${finalItems.length} total in catalog.`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
