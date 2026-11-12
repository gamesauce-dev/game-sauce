// Platform ids: our platform table holds each provider's own number for a console (ScreenScraper "systemeid", TheGamesDB platform id).
// This works out, from the provider's live list, which of ours are right, which are missing, which point at the wrong console, and
// what the likely number is by name. Nothing here writes to the database: the admin accepts changes in the UI.

const clean = (s) => String(s || '').toLowerCase()
  .replace(/\([^)]*\)/g, ' ')            // "Nintendo 64 (N64)" -> "Nintendo 64"
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'of', 'system', 'console', 'game', 'games', 'home', 'video', 'entertainment', 'computer']);
const tokens = (s) => clean(s).split(' ').filter((t) => t && !STOP.has(t));
const squash = (s) => clean(s).replace(/ /g, '');

/** 0-100: how alike two console names are. Exact (ignoring spaces, case, brackets) = 100. */
export function nameScore(a, b) {
  const sa = squash(a), sb = squash(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 100;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const common = ta.filter((t) => setB.has(t)).length;
  const jac = common / new Set([...ta, ...tb]).size;
  // every word of the shorter name appears in the longer one ("Sega Genesis" in "Sega Genesis / Mega Drive")
  const [short, long] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  const contained = short.every((t) => long.has(t));
  // numbers matter: "PlayStation 2" is not "PlayStation 3"
  const nums = (arr) => arr.filter((t) => /\d/.test(t)).sort().join(',');
  if (nums(ta) !== nums(tb)) return Math.min(25, Math.round(jac * 40));
  return Math.round(Math.max(jac * 80, contained ? 60 + 25 * (short.length / long.size) : 0));
}

/** Best provider entries for one of our platforms (by its name, then short name). Highest first. */
export function candidatesFor(platform, providerList, limit = 3) {
  const scored = providerList.map((p) => {
    const names = [p.name, p.alias, p.short].filter(Boolean);
    const score = Math.max(...names.flatMap((n) => [nameScore(platform.name, n), nameScore(platform.short_name, n) * 0.9]));
    return { id: p.id, name: p.name, score: Math.round(score) };
  }).filter((c) => c.score >= 40).sort((x, y) => y.score - x.score || x.id - y.id);
  return scored.slice(0, limit);
}

const CONFIDENT = 75;

/**
 * Judge one provider for one platform.
 *   ok          the stored id exists on the provider and the names agree
 *   suspicious  the stored id exists but names a quite different console (likely the wrong number)
 *   unresolved  the stored id is not on the provider's list at all
 *   missing     no id stored
 * `suggestion` is the best name match (only offered when it is not the stored id).
 */
export function judge(platform, storedId, providerList) {
  const byId = new Map(providerList.map((p) => [p.id, p]));
  const cands = candidatesFor(platform, providerList);
  const best = cands[0] || null;
  if (storedId == null) {
    return { status: 'missing', current: null, suggestion: best, confident: Boolean(best && best.score >= CONFIDENT), candidates: cands };
  }
  const hit = byId.get(Number(storedId));
  if (!hit) return { status: 'unresolved', current: { id: Number(storedId), name: null }, suggestion: best, confident: Boolean(best && best.score >= CONFIDENT), candidates: cands };
  const score = Math.max(nameScore(platform.name, hit.name), nameScore(platform.short_name, hit.name) * 0.9, hit.alias ? nameScore(platform.name, hit.alias) : 0);
  const current = { id: hit.id, name: hit.name, score: Math.round(score) };
  // A provider entry with exactly our name beats one that only reads the same once its brackets are dropped ("Xbox 360" against "Xbox 360 (Arcade)").
  const rawName = (s) => String(s || '').toLowerCase().replace(/s+/g, ' ').trim();
  const exact = providerList.find((p) => p.id !== hit.id && rawName(p.name) === rawName(platform.name));
  if (exact && rawName(hit.name) !== rawName(platform.name)) return { status: 'suspicious', current, suggestion: { id: exact.id, name: exact.name, score: 100 }, confident: true, candidates: cands };
  if (score >= 45 || !best || best.id === hit.id) return { status: 'ok', current, suggestion: null, confident: false, candidates: cands };
  return { status: 'suspicious', current, suggestion: best, confident: false, candidates: cands };
}

/** The whole report: one row per platform per provider that needs a look, plus counts. */
export function buildReport(platforms, providers) {
  const rows = [];
  const counts = {};
  for (const [key, { list, field }] of Object.entries(providers)) {
    counts[key] = { checked: 0, ok: 0, missing: 0, unresolved: 0, suspicious: 0, list: list.length };
    for (const p of platforms) {
      const j = judge(p, p[field], list);
      counts[key].checked++; counts[key][j.status]++;
      if (j.status !== 'ok') rows.push({ slug: p.slug, name: p.name, provider: key, field, ...j });
    }
  }
  return { counts, rows };
}
