// scripts/add-item.mjs
// Usage: node scripts/add-item.mjs "<title>" "<type>" "<year_hint>"
// Appends an entry to data/titles.json and exposes its id as a GitHub Actions output (new_id).

import fs from 'fs';

const [, , titleArg, typeArg, yearArg] = process.argv;

if (!titleArg || !typeArg) {
  console.error('Missing arguments. Usage: node add-item.mjs "<title>" "<type>" "<year_hint>"');
  process.exit(1);
}

const VALID_TYPES = ['series', 'movie', 'anime', 'play'];
const type = VALID_TYPES.includes(typeArg) ? typeArg : 'series';

const TITLES_PATH = 'data/titles.json';

function readJSON(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function slugify(s) {
  return (
    s
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^\u0600-\u06FFa-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

const titles = readJSON(TITLES_PATH, []);
const id = `${slugify(titleArg)}-${Date.now().toString(36).slice(-5)}`;

titles.push({
  id,
  title: titleArg.trim(),
  type,
  year_hint: (yearArg || '').trim()
});

fs.writeFileSync(TITLES_PATH, JSON.stringify(titles, null, 2) + '\n');
console.log(`Added "${titleArg}" as ${id}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_id=${id}\n`);
}
