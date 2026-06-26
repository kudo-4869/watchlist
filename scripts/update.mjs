// scripts/update.mjs
// Run by GitHub Actions (daily cron + manual dispatch + add-item/refresh/move flows).
//
// Data sources (all free, no signup):
//   - Jikan (MyAnimeList wrapper): anime — poster, synopsis, status, episodes, relations, recommendations
//   - TVmaze: series/cartoon (and anime fallback if not found on MAL)
//   - iTunes Search: movies (and anime-film fallback)
//
// If a title entry has external_source + external_id ("pinned" via the site's re-match search),
// that exact record is fetched directly instead of doing a fuzzy text search — this fixes
// wrong/mismatched auto-fetched data permanently.
//
// Descriptions and English news titles are translated to Arabic via a free Google Translate
// endpoint. News is scanned via Google News RSS and classified by keyword. Status changes,
// cancellations, and new seasons/episodes are auto-detected and logged. If a previously
// "completed" item gets a new season/episode, the user's personal watch status flips to
// "incomplete" so they notice. If the underlying status itself reaches "completed", any stale
// manual status override is dropped (handled client-side, see index.html).
//
// "play", "story" and "game" items have no automatic data source — manual-only.
//
// Env vars:
//   ONLY_ID - optional, limit processing to a single title id

import fs from 'fs';

const ONLY_ID = process.env.ONLY_ID || null;

const TITLES_PATH = 'data/titles.json';
const CATALOG_PATH = 'data/catalog.json';
const USERDATA_PATH = 'data/userdata.json';

const STATUS_AR = { ongoing: 'مستمر', completed: 'مكتمل', unclear: 'غير منتهي', cancelled: 'تكنسل' };
const AUTO_FETCH_TYPES = new Set(['series', 'anime', 'cartoon', 'movie']);

const CANCEL_KEYWORDS = ['cancel', 'canceled', 'cancelled', 'إلغاء', 'الغاء'];
const RENEW_KEYWORDS = ['renew', 'season 2', 'season two', 'new season', 'next season', 'final season', 'تجديد', 'موسم جديد', 'موسم ثاني', 'موسم ثالث', 'موسم رابع'];
const SEASON_KEYWORDS = [...CANCEL_KEYWORDS, ...RENEW_KEYWORDS];
const RELEASE_KEYWORDS = [
  'premiere', 'release date', 'delay', 'delayed', 'postponed', 'air date', 'drops on', 'schedule',
  'موعد العرض', 'تأجيل', 'تاجيل', 'تاريخ العرض', 'تاريخ الإصدار', 'الحلقة القادمة', 'يعرض في'
];

/* ---------- generic helpers ---------- */
function readJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}
function today() { return new Date().toISOString().slice(0, 10); }
function arStatus(s) { return STATUS_AR[s] || s || 'غير منتهي'; }
function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
function stripCdata(s) {
  if (!s) return '';
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}
function hasArabic(s) { return /[\u0600-\u06FF]/.test(s || ''); }
function classify(text) {
  const t = (text || '').toLowerCase();
  if (SEASON_KEYWORDS.some(k => t.includes(k))) return 'season_news';
  if (RELEASE_KEYWORDS.some(k => t.includes(k))) return 'release_news';
  return 'general_news';
}
function isCancelNews(text) {
  const t = (text || '').toLowerCase();
  return CANCEL_KEYWORDS.some(k => t.includes(k));
}
function bigArtwork(url) {
  if (!url) return '';
  return url.replace(/\d+x\d+bb(\.\w+)$/, '600x600bb$1');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------- free translation (no key, best-effort) ---------- */
async function translateToArabic(text) {
  if (!text) return text;
  if (hasArabic(text)) return text;
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ar&dt=t&q=${encodeURIComponent(text.slice(0, 1800))}`);
    if (!res.ok) return text;
    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0].map(chunk => chunk[0]).join('');
    }
    return text;
  } catch (e) {
    console.error('Translate failed:', e.message);
    return text;
  }
}

/* ---------- Google News RSS (free, no key) ---------- */
const TYPE_QUALIFIER_AR = { series:'مسلسل', anime:'أنمي', cartoon:'كرتون', movie:'فيلم' };
const TYPE_QUALIFIER_EN = { series:'series', anime:'anime', cartoon:'cartoon', movie:'movie' };
function isRelevant(articleTitle, refTitle) {
  const a = (articleTitle || '').toLowerCase();
  const r = (refTitle || '').toLowerCase().trim();
  if (!r) return true;
  const rAr = hasArabic(r), aAr = hasArabic(a);
  if (rAr !== aAr) return true; // can't cheaply validate across scripts — let it through
  return a.includes(r);
}
function newsId(itemId, cat, seed) {
  let h = 0;
  const s = `${itemId}|${cat}|${seed}`;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return `n${Math.abs(h)}`;
}
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

/* ---------- Jikan / MyAnimeList (anime, no key needed) ---------- */
async function jikanSearch(title) {
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=5&sfw=true`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  } catch (e) { return []; }
}
async function jikanFull(id) {
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${id}/full`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.data || null;
  } catch (e) { return null; }
}
async function jikanRecommendations(id) {
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${id}/recommendations`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).slice(0, 6).map(r => ({
      mal_id: r.entry.mal_id,
      title: r.entry.title,
      image: r.entry.images && r.entry.images.jpg ? r.entry.images.jpg.image_url : ''
    }));
  } catch (e) { return []; }
}
function mapJikanStatus(s) {
  const t = (s || '').toLowerCase();
  if (t.includes('currently airing')) return 'ongoing';
  if (t.includes('finished airing')) return 'completed';
  return 'unclear'; // Not yet aired / unknown
}
function jikanRelations(raw) {
  if (!raw || !raw.relations) return [];
  const wanted = ['Sequel', 'Prequel', 'Side story', 'Spin-off', 'Alternative version', 'Full story'];
  const out = [];
  for (const rel of raw.relations) {
    if (!wanted.includes(rel.relation)) continue;
    for (const e of rel.entry) {
      if (e.type !== 'anime') continue;
      out.push({ relation: rel.relation, mal_id: e.mal_id, name: e.name });
    }
  }
  return out.slice(0, 8);
}

/* ---------- TVmaze (series / cartoon / anime-fallback, no key needed) ---------- */
async function tvmazeLookup(title) {
  try {
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}
async function tvmazeById(id) {
  try {
    const res = await fetch(`https://api.tvmaze.com/shows/${id}`);
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
  if (t.includes('ended')) return 'completed';
  if (t.includes('running')) return 'ongoing';
  return 'unclear';
}

/* ---------- iTunes Search (movies / anime-film fallback, no key needed) ---------- */
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
async function itunesById(id) {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results || [])[0] || null;
  } catch (e) { return null; }
}
async function itunesLongDescription(trackId) {
  const r = await itunesById(trackId);
  return r ? (r.longDescription || r.shortDescription || '') : '';
}

/* ---------- per-item processing ---------- */
async function processItem(titleEntry, prev) {
  const { id, title, type, year_hint, external_source, external_id, collection } = titleEntry;
  const news = { season_news: [], release_news: [], general_news: [] };

  const meta = {
    id, title, type, collection: collection || null,
    external_source: external_source || prev?.external_source || null,
    external_id: external_id || prev?.external_id || null,
    year: prev?.year || '',
    poster_url: prev?.poster_url || '',
    description: prev?.description || '',
    description_en: prev?.description_en || '',
    status: prev?.status || 'unclear',
    total_seasons: prev?.total_seasons || null,
    total_episodes: prev?.total_episodes || null,
    next_episode_date: prev?.next_episode_date || null,
    relations: prev?.relations || [],
    recommendations: prev?.recommendations || []
  };

  let forceCancelled = false;

  if (AUTO_FETCH_TYPES.has(type)) {
    try {
      if (type === 'movie') {
        let found = null;
        if (external_source === 'itunes' && external_id) found = await itunesById(external_id);
        if (!found) found = await itunesLookupMovie(title, year_hint);
        if (found) {
          meta.external_source = 'itunes'; meta.external_id = found.trackId;
          meta.title = found.trackName || title;
          meta.year = (found.releaseDate || '').slice(0, 4) || meta.year;
          meta.poster_url = bigArtwork(found.artworkUrl100) || meta.poster_url;
          const rawDesc = (await itunesLongDescription(found.trackId)) || found.longDescription || '';
          if (rawDesc && rawDesc !== meta.description_en) {
            meta.description = await translateToArabic(rawDesc);
            meta.description_en = rawDesc;
          }
        } else { console.log('No iTunes match for', title); }

      } else if (type === 'anime') {
        let jikanRaw = null;
        if (external_source === 'jikan' && external_id) {
          jikanRaw = await jikanFull(external_id);
        } else if (!external_source) {
          const results = await jikanSearch(title);
          if (results.length) jikanRaw = await jikanFull(results[0].mal_id);
          await sleep(450);
        }
        if (jikanRaw) {
          meta.external_source = 'jikan'; meta.external_id = jikanRaw.mal_id;
          meta.title = jikanRaw.title || title;
          meta.year = jikanRaw.aired && jikanRaw.aired.prop && jikanRaw.aired.prop.from ? String(jikanRaw.aired.prop.from.year || '') : meta.year;
          meta.poster_url = (jikanRaw.images && jikanRaw.images.jpg ? jikanRaw.images.jpg.large_image_url : '') || meta.poster_url;
          const rawDesc = stripHtml(jikanRaw.synopsis || '');
          if (rawDesc && rawDesc !== meta.description_en) {
            meta.description = await translateToArabic(rawDesc);
            meta.description_en = rawDesc;
          }
          meta.status = mapJikanStatus(jikanRaw.status);
          meta.total_seasons = meta.total_seasons || 1;
          meta.total_episodes = jikanRaw.episodes || meta.total_episodes;
          meta.relations = jikanRelations(jikanRaw);
          await sleep(450);
          meta.recommendations = await jikanRecommendations(jikanRaw.mal_id);
          await sleep(450);

          if (prev && prev.status && prev.status !== meta.status) {
            news.season_news.push({ id: newsId(id, 'season_news', `status-${meta.status}`), date: today(), summary: `تغيّرت حالة "${meta.title}" من ${arStatus(prev.status)} إلى ${arStatus(meta.status)}`, source: 'MyAnimeList' });
          }
        } else if (external_source === 'tvmaze' && external_id) {
          const tv = await tvmazeById(external_id);
          if (tv) {
            await applyTvmazeMeta(meta, tv, news, prev, today, arStatus);
            meta.external_source = 'tvmaze'; meta.external_id = tv.id;
          }
        } else {
          const tv = await tvmazeLookup(title);
          if (tv) {
            await applyTvmazeMeta(meta, tv, news, prev, today, arStatus);
            meta.external_source = 'tvmaze'; meta.external_id = tv.id;
          } else {
            const movieFallback = await itunesLookupMovie(title, year_hint);
            if (movieFallback) {
              meta.external_source = 'itunes'; meta.external_id = movieFallback.trackId;
              meta.title = movieFallback.trackName || title;
              meta.year = (movieFallback.releaseDate || '').slice(0, 4) || meta.year;
              meta.poster_url = bigArtwork(movieFallback.artworkUrl100) || meta.poster_url;
              const rawDesc = (await itunesLongDescription(movieFallback.trackId)) || '';
              if (rawDesc && rawDesc !== meta.description_en) {
                meta.description = await translateToArabic(rawDesc);
                meta.description_en = rawDesc;
              }
            } else {
              console.log('No Jikan/TVmaze/iTunes match for', title);
            }
          }
        }

      } else {
        // series / cartoon
        let tv = null;
        if (external_source === 'tvmaze' && external_id) tv = await tvmazeById(external_id);
        if (!tv) tv = await tvmazeLookup(title);
        if (tv) {
          meta.external_source = 'tvmaze'; meta.external_id = tv.id;
          await applyTvmazeMeta(meta, tv, news, prev, today, arStatus);
        } else {
          console.log('No TVmaze match for', title);
        }
      }
    } catch (e) {
      console.error('Metadata lookup error for', title, e.message);
    }
  }
  // type === 'play' | 'story' | 'game' -> manual data only via overrides

  // Google News RSS — best effort, free, classified by keyword, translated to Arabic
  try {
    const searchTitle = meta.title || title;
    const qualAr = TYPE_QUALIFIER_AR[type] || '';
    const qualEn = TYPE_QUALIFIER_EN[type] || '';
    const arQuery = `"${searchTitle}" ${qualAr}`.trim();
    const enQuery = `"${searchTitle}" ${qualEn}`.trim();
    const [arRaw, enRaw] = await Promise.all([
      fetchGoogleNewsRSS(arQuery, 'ar', 'SA', 'SA:ar'),
      fetchGoogleNewsRSS(enQuery, 'en-US', 'US', 'US:en')
    ]);
    const merged = [
      ...arRaw.map(it => ({ ...it, lang: 'ar' })),
      ...enRaw.map(it => ({ ...it, lang: 'en' }))
    ];
    const seenLinks = new Set(prev?.seenLinks || []);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const it of merged) {
      if (seenLinks.has(it.link)) continue;
      const t = new Date(it.pubDate).getTime();
      if (isNaN(t) || t < cutoff) continue;
      if (!isRelevant(it.title, searchTitle)) continue;
      seenLinks.add(it.link);
      const cat = classify(it.title);
      if (cat === 'season_news' && isCancelNews(it.title)) forceCancelled = true;
      const summary = it.lang === 'en' ? await translateToArabic(it.title) : it.title;
      news[cat].push({ id: newsId(id, cat, it.link), date: it.pubDate ? it.pubDate.slice(0, 16) : '', summary, source: it.source || 'Google News' });
    }
    meta.seenLinks = Array.from(seenLinks).slice(-250);
  } catch (e) {
    console.error('News merge error for', title, e.message);
    meta.seenLinks = prev?.seenLinks || [];
  }

  if (forceCancelled && meta.status !== 'cancelled' && AUTO_FETCH_TYPES.has(type)) {
    if (prev && prev.status && prev.status !== 'cancelled') {
      news.season_news.unshift({ id: newsId(id, 'season_news', `cancel-${today()}`), date: today(), summary: `رصدنا خبرًا يشير لإلغاء "${meta.title}"`, source: 'Google News' });
    }
    meta.status = 'cancelled';
  }

  for (const cat of ['season_news', 'release_news', 'general_news']) {
    const prevList = (prev && prev.news && prev.news[cat]) || [];
    news[cat] = [...news[cat], ...prevList].slice(0, 8);
  }

  meta.news = news;
  meta.checkedAt = new Date().toISOString();
  return meta;
}

async function applyTvmazeMeta(meta, tv, news, prev, todayFn, arStatusFn) {
  meta.title = tv.name || meta.title;
  meta.year = (tv.premiered || '').slice(0, 4) || meta.year;
  meta.poster_url = (tv.image && (tv.image.original || tv.image.medium)) || meta.poster_url;
  const rawDesc = stripHtml(tv.summary || '');
  if (rawDesc && rawDesc !== meta.description_en) {
    meta.description = await translateToArabic(rawDesc);
    meta.description_en = rawDesc;
  }
  meta.status = mapTvmazeStatus(tv.status);

  const counts = await tvmazeEpisodeCounts(tv.id);
  meta.total_seasons = counts.seasons || meta.total_seasons;
  meta.total_episodes = counts.episodes || meta.total_episodes;

  const newNextDate = await tvmazeNextEpisode(tv.id);

  if (prev && prev.status && prev.status !== meta.status) {
    news.season_news.push({ id: newsId(meta.id, 'season_news', `status-${meta.status}`), date: todayFn(), summary: `تغيّرت حالة "${meta.title}" من ${arStatusFn(prev.status)} إلى ${arStatusFn(meta.status)}`, source: 'TVmaze' });
  }
  if (newNextDate && prev?.next_episode_date && newNextDate !== prev.next_episode_date) {
    news.release_news.push({ id: newsId(meta.id, 'release_news', `next-${newNextDate}`), date: todayFn(), summary: `تغيّر موعد الحلقة القادمة من ${prev.next_episode_date} إلى ${newNextDate}`, source: 'TVmaze' });
  } else if (newNextDate && !prev?.next_episode_date) {
    news.release_news.push({ id: newsId(meta.id, 'release_news', `next-${newNextDate}`), date: todayFn(), summary: `تم تحديد موعد الحلقة القادمة: ${newNextDate}`, source: 'TVmaze' });
  }
  meta.next_episode_date = newNextDate;
}

/* ---------- main ---------- */
async function main() {
  const titles = readJSON(TITLES_PATH, []);
  const prevCatalog = readJSON(CATALOG_PATH, { items: [] });
  const userdata = readJSON(USERDATA_PATH, { progress: {}, overrides: {}, hidden: {} });
  let userdataChanged = false;

  // userdata may be encrypted ({encrypted:true,...}) — the season-bump auto-flip below only
  // works when we can read plaintext progress. If encrypted, skip that specific automation
  // (the client-side status-baseline check in index.html still handles the override-staleness case).
  const canReadProgress = userdata && userdata.progress && !userdata.encrypted;

  const prevById = {};
  (prevCatalog.items || []).forEach(i => { prevById[i.id] = i; });

  const targets = ONLY_ID ? titles.filter(t => t.id === ONLY_ID) : titles;
  if (targets.length === 0) console.log('Nothing to process.');

  const results = [];
  for (const t of targets) {
    console.log('Processing:', t.title);
    const prev = prevById[t.id];
    const item = await processItem(t, prev);
    results.push(item);

    if (canReadProgress) {
      const prevSeasons = prev?.total_seasons || 0;
      const prevEpisodes = prev?.total_episodes || 0;
      const newSeasons = item.total_seasons || 0;
      const newEpisodes = item.total_episodes || 0;
      const grew = newSeasons > prevSeasons || newEpisodes > prevEpisodes;
      if (grew && userdata.progress[t.id] && userdata.progress[t.id].watchStatus === 'completed') {
        userdata.progress[t.id].watchStatus = 'incomplete';
        userdata.progress[t.id].updatedAt = new Date().toISOString();
        userdataChanged = true;
        console.log(`-> ${t.title}: new season/episode detected, flipped personal status to "incomplete"`);
      }
    }

    await sleep(300);
  }

  let finalItems;
  if (ONLY_ID) {
    finalItems = (prevCatalog.items || []).filter(i => i.id !== ONLY_ID);
    finalItems.push(...results);
  } else {
    finalItems = results;
  }

  writeJSON(CATALOG_PATH, { updatedAt: new Date().toISOString(), items: finalItems });
  if (userdataChanged) writeJSON(USERDATA_PATH, userdata);
  console.log(`Done. ${results.length} item(s) processed, ${finalItems.length} total in catalog.`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
