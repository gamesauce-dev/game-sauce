import express from 'express';
import { requireAdmin } from './auth.js';
import { canChat, listPeople, sendMessage, thread, conversations, markRead, deleteConversation, deleteForMe, recall, postNotice, listNotices, markNoticeRead, dismissNotice, withdrawNotice, summary, MAX_LEN, RECALL_MINUTES } from '../lib/messages.js';

const router = express.Router();
const me = (req) => Number(req.user?.id ?? -1);
const fail = (res, err) => { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; };
// Everything below is the signed-in person's own: a conversation is only ever read with the two people in it, and no route here (the admin's included) reads anyone else's.
const chatOnly = (req, res, next) => (canChat(req.user) ? next() : res.status(403).json({ error: 'Chat is not available for this account. Notices from the admin still reach you here.' }));

// What the page polls: unread counts and the newest message and notice (for the badge and the toast).
router.get('/summary', (req, res) => res.json({ ...summary(me(req), req.user), max_length: MAX_LEN, recall_minutes: RECALL_MINUTES }));

router.get('/people', chatOnly, (req, res) => res.json({ items: listPeople(me(req)) }));
router.get('/conversations', chatOnly, (req, res) => res.json({ items: conversations(me(req)) }));
router.get('/with/:id(\\d+)', chatOnly, (req, res) => res.json({ items: thread(me(req), req.params.id), max_length: MAX_LEN }));
router.post('/with/:id(\\d+)', chatOnly, (req, res) => {
  try { const m = sendMessage(req.user, Number(req.params.id), { body: req.body?.body, game: req.body?.game || null, replyTo: req.body?.reply_to ?? null }); res.status(201).json({ id: m.id }); }
  catch (err) { fail(res, err); }
});
router.delete('/with/:id(\\d+)', chatOnly, (req, res) => res.json(deleteConversation(me(req), req.params.id)));   // the whole conversation, for me only
router.post('/with/:id(\\d+)/read', chatOnly, (req, res) => res.json({ read: markRead(me(req), req.params.id) }));

// One message: delete it for me, or (the sender, in the first minutes) recall it for both.
router.delete('/:id(\\d+)', chatOnly, (req, res) => { try { res.json(deleteForMe(me(req), req.params.id)); } catch (err) { fail(res, err); } });
router.post('/:id(\\d+)/recall', chatOnly, (req, res) => { try { res.json(recall(me(req), req.params.id)); } catch (err) { fail(res, err); } });

// Notices from the admin to everyone (a play-only account reads these too).
router.get('/notices', (req, res) => res.json({ items: listNotices(me(req)) }));
router.post('/notices', requireAdmin, (req, res) => { try { const r = postNotice(req.user, { body: req.body?.body, hours: req.body?.hours }); req.auditDetail = { notice: r.id }; res.status(201).json(r); } catch (err) { fail(res, err); } });
router.post('/notices/:id(\\d+)/read', (req, res) => { try { res.json(markNoticeRead(me(req), req.params.id)); } catch (err) { fail(res, err); } });
router.delete('/notices/:id(\\d+)', (req, res) => { try { res.json(dismissNotice(me(req), req.params.id)); } catch (err) { fail(res, err); } });
router.post('/notices/:id(\\d+)/withdraw', requireAdmin, (req, res) => { try { res.json(withdrawNotice(req.params.id)); } catch (err) { fail(res, err); } });

export default router;
