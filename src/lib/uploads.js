// The limits every upload is given. Capping the file alone is not enough: the text fields sent with it are held in memory as they arrive, before the route
// has looked at anything, and without a limit there can be any number of them. The pages send a handful of short ones at most.
const MAX_FIELDS = 12;
const MAX_FIELD_BYTES = 16 * 1024;

/** For multer's `limits`: files of at most fileSize bytes, at most `files` of them, and only a few short text fields. */
export const uploadLimits = (fileSize, files = 1) => ({ fileSize, files, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES, parts: MAX_FIELDS + files });
