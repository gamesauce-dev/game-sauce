// What an orphan is, in one place, for every list, count and the "Delete orphans" purge.
// A game scanned from one of your folders (in_place) whose source has gone: the source was removed with its games kept, or the game was locked
// when the source and its games were removed. A scan that finds the same file again takes it back.
// A game added through Add ROMs never had a source. It is not an orphan: game-sauce holds the copy, which may be the only one.
export const orphanSql = (alias = 'r') => `${alias}.in_place = 1 AND (${alias}.source_id IS NULL OR ${alias}.source_id NOT IN (SELECT id FROM sources))`;
