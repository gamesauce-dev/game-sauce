// Play-only accounts: the admin can give someone a cut-down screen that is just "pick a game and play it".
// This is enforced HERE, on the server, not just by hiding buttons: a play-only person who types an address
// into the browser still gets "not allowed". It is an allow-list: anything not named below is refused.
//
// What a play-only person may do:
//   - sign in / out, read who they are, change their own password, picture and sessions, run the welcome tour   (/api/auth/...)
//   - list games and open one, with its cover, so they can pick one (read only)
//   - play a game, and keep their own save states
//   - mark favourites (their own)
//   - see the platform list and the counts the screen needs
// What they may not do: download ROM files, browse folders, change anything about games, collections, sources,
// providers, emulators, backups or other people. (Admin-only routes stay admin-only on top of this.)

const ALLOW = [
  // [method, path pattern]
  ['GET', /^\/auth\//], ['POST', /^\/auth\//], ['PUT', /^\/auth\//], ['DELETE', /^\/auth\//], ['PATCH', /^\/auth\/(?!users)/],
  ['GET', /^\/health$/],
  ['GET', /^\/platforms$/],
  ['GET', /^\/stats$/],
  ['GET', /^\/prefs$/],
  ['GET', /^\/roms\/?$/],
  ['GET', /^\/roms\/facets$/],
  ['GET', /^\/roms\/recently-played$/],
  ['GET', /^\/roms\/playable$/],
  ['GET', /^\/roms\/\d+$/],
  ['GET', /^\/roms\/\d+\/(cover|media\/[a-z0-9_]+)$/i],
  ['GET', /^\/roms\/\d+\/play(\/.*)?$/],
  ['GET', /^\/roms\/\d+\/saves(\/\d+\/(file|screenshot))?$/],
  ['POST', /^\/roms\/\d+\/saves$/],
  ['PUT', /^\/roms\/\d+\/saves\/\d+\/screenshot$/],
  ['DELETE', /^\/roms\/\d+\/saves\/\d+$/],
  ['POST', /^\/roms\/\d+\/favorite$/]
];

export function playOnlyAllows(method, path) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '').split('?')[0];
  return ALLOW.some(([am, re]) => (am === m || (am === 'GET' && m === 'HEAD')) && re.test(p));
}

/** Express middleware: mount after the user is known (after requireAuth). */
export function playOnlyGuard(req, res, next) {
  if (req.user?.play_only && !playOnlyAllows(req.method, req.path)) {
    return res.status(403).json({ error: 'This account is set up for playing games only' });
  }
  next();
}
