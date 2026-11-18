'use strict';

const { pbkdf2, randomBytes, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten
} = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { HttpsError, onCall } = require('firebase-functions/v2/https');

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const db = getFirestore();
const DEFAULT_ADMIN_EMAIL = 'phoenix28.tech@gmail.com';
const ROSTER_IDS = ['island-mombasa', 'mainland-likoni'];
const RETAINED_BACKUPS = 12;
const HISTORY_PIN_ITERATIONS = 210000;
const HISTORY_PIN_MAX_ATTEMPTS = 5;
const HISTORY_PIN_LOCKOUT_MS = 15 * 60 * 1000;
const HISTORY_PIN_WINDOW_MS = 15 * 60 * 1000;
const HISTORY_PIN_PATTERN = /^\d{6,12}$/;
const historyPinPbkdf2 = promisify(pbkdf2);
const historyPinReference = db.doc('systemSecrets/rosterHistoryDeletion');

const DEFAULT_EVENTS = Object.freeze({
  newAccessRequest: { inApp: true, email: false },
  accessApproved: { inApp: true, email: false },
  accessDeclined: { inApp: true, email: false },
  accessRevoked: { inApp: true, email: false },
  rosterPublished: { inApp: true, email: false },
  announcement: { inApp: true, email: false }
});

function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function requireRosterAdmin(request) {
  const token = request.auth && request.auth.token;
  if (!token || token.email_verified !== true ||
      normalizedEmail(token.email) !== DEFAULT_ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'Only the verified roster administrator can manage history.');
  }
  return request.auth.uid;
}

function validateHistoryPin(pin, fieldName) {
  if (typeof pin !== 'string' || !HISTORY_PIN_PATTERN.test(pin)) {
    throw new HttpsError('invalid-argument', `${fieldName} must contain 6 to 12 digits.`);
  }
}

async function deriveHistoryPinHash(pin, salt) {
  return historyPinPbkdf2(pin, salt, HISTORY_PIN_ITERATIONS, 32, 'sha256');
}

async function createHistoryPinRecord(pin, uid) {
  const salt = randomBytes(16);
  const hash = await deriveHistoryPinHash(pin, salt);
  return {
    schemaVersion: 1,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    iterations: HISTORY_PIN_ITERATIONS,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid
  };
}

async function historyPinMatches(pin, saved) {
  if (saved && typeof saved.pin === 'string' && /^\d{6,12}$/.test(saved.pin)) {
    const candidate = Buffer.from(pin);
    const expected = Buffer.from(saved.pin);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  if (!saved || saved.schemaVersion !== 1 ||
      saved.iterations !== HISTORY_PIN_ITERATIONS ||
      typeof saved.salt !== 'string' || !/^[a-f0-9]{32}$/.test(saved.salt) ||
      typeof saved.hash !== 'string' || !/^[a-f0-9]{64}$/.test(saved.hash)) {
    return false;
  }
  const candidate = await deriveHistoryPinHash(pin, Buffer.from(saved.salt, 'hex'));
  const expected = Buffer.from(saved.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function getHistoryPinAttemptState(snapshot, now) {
  const data = snapshot.exists ? snapshot.data() : {};
  const savedWindowStart = Number.isSafeInteger(data.windowStartedAtMs)
    ? data.windowStartedAtMs
    : now;
  if (now - savedWindowStart >= HISTORY_PIN_WINDOW_MS) {
    return { failedAttempts: 0, windowStartedAtMs: now, lockedUntilMs: 0 };
  }
  const lockedUntilMs = Number.isSafeInteger(data.lockedUntilMs) ? data.lockedUntilMs : 0;
  return {
    failedAttempts: Number.isSafeInteger(data.failedAttempts) ? data.failedAttempts : 0,
    windowStartedAtMs: savedWindowStart,
    lockedUntilMs
  };
}

function recordHistoryPinFailure(transaction, reference, state, now) {
  const failedAttempts = state.failedAttempts + 1;
  const lockedUntilMs = failedAttempts >= HISTORY_PIN_MAX_ATTEMPTS
    ? now + HISTORY_PIN_LOCKOUT_MS
    : 0;
  transaction.set(reference, {
    failedAttempts,
    windowStartedAtMs: state.windowStartedAtMs,
    lockedUntilMs,
    updatedAtMs: now
  });
  return lockedUntilMs;
}

function throwHistoryPinOutcome(outcome) {
  if (outcome === 'locked') {
    throw new HttpsError('resource-exhausted', 'Too many incorrect PIN attempts. Try again in 15 minutes.');
  }
  if (outcome === 'invalid-pin') {
    throw new HttpsError('permission-denied', 'The deletion PIN is incorrect.');
  }
  if (outcome === 'pin-not-set') {
    throw new HttpsError('failed-precondition', 'Set a deletion PIN before deleting roster history.');
  }
  if (outcome === 'invalid-verifier') {
    throw new HttpsError('failed-precondition', 'The saved PIN verifier is invalid. Set a new PIN.');
  }
  if (outcome === 'no-current-pin') {
    throw new HttpsError('failed-precondition', 'No PIN exists yet; leave the current PIN blank to set the first one.');
  }
  if (outcome === 'history-not-found') {
    throw new HttpsError('not-found', 'The selected archived roster no longer exists.');
  }
  throw new HttpsError('internal', 'The history PIN operation could not be completed.');
}

exports.setRosterHistoryPin = onCall(async request => {
  const uid = requireRosterAdmin(request);
  const data = request.data && typeof request.data === 'object' ? request.data : {};
  const currentPin = data.currentPin === undefined ? '' : data.currentPin;
  validateHistoryPin(data.newPin, 'New PIN');
  if (currentPin !== '' && (typeof currentPin !== 'string' || !HISTORY_PIN_PATTERN.test(currentPin))) {
    throw new HttpsError('invalid-argument', 'Current PIN must contain 6 to 12 digits.');
  }

  const newRecord = await createHistoryPinRecord(data.newPin, uid);
  const attemptsReference = db.doc(`historyPinAttempts/${uid}`);
  let outcome = 'success';
  await db.runTransaction(async transaction => {
    outcome = 'success';
    const [savedPin, attempts] = await Promise.all([
      transaction.get(historyPinReference),
      transaction.get(attemptsReference)
    ]);
    const now = Date.now();
    const state = getHistoryPinAttemptState(attempts, now);
    if (state.lockedUntilMs > now) {
      outcome = 'locked';
      return;
    }

    if (savedPin.exists) {
      if (!await historyPinMatches(currentPin, savedPin.data())) {
        outcome = 'invalid-pin';
        const lockedUntilMs = recordHistoryPinFailure(transaction, attemptsReference, state, now);
        if (lockedUntilMs > now) outcome = 'locked';
        return;
      }
    } else if (currentPin !== '') {
      outcome = 'no-current-pin';
      return;
    }

    transaction.set(historyPinReference, newRecord);
    if (attempts.exists) transaction.delete(attemptsReference);
  });
  if (outcome !== 'success') throwHistoryPinOutcome(outcome);
  return { ok: true };
});

exports.deleteRosterHistory = onCall(async request => {
  const uid = requireRosterAdmin(request);
  const data = request.data && typeof request.data === 'object' ? request.data : {};
  validateHistoryPin(data.pin, 'PIN');
  if (typeof data.historyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.historyId)) {
    throw new HttpsError('invalid-argument', 'The selected history record is invalid.');
  }

  const attemptsReference = db.doc(`historyPinAttempts/${uid}`);
  const historyReference = db.collection('rosterHistory').doc(data.historyId);
  let outcome = 'success';
  await db.runTransaction(async transaction => {
    outcome = 'success';
    const [savedPin, attempts, historyRecord] = await Promise.all([
      transaction.get(historyPinReference),
      transaction.get(attemptsReference),
      transaction.get(historyReference)
    ]);
    const now = Date.now();
    const state = getHistoryPinAttemptState(attempts, now);
    if (state.lockedUntilMs > now) {
      outcome = 'locked';
      return;
    }
    if (!savedPin.exists) {
      outcome = 'pin-not-set';
      return;
    }
    if (!await historyPinMatches(data.pin, savedPin.data())) {
      outcome = 'invalid-pin';
      const lockedUntilMs = recordHistoryPinFailure(transaction, attemptsReference, state, now);
      if (lockedUntilMs > now) outcome = 'locked';
      return;
    }
    if (!historyRecord.exists) {
      outcome = 'history-not-found';
      return;
    }

    transaction.delete(historyReference);
    if (typeof savedPin.data().pin === 'string') {
      transaction.set(historyPinReference, await createHistoryPinRecord(data.pin, uid));
    }
    if (attempts.exists) transaction.delete(attemptsReference);
  });
  if (outcome !== 'success') throwHistoryPinOutcome(outcome);
  return { ok: true };
});

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

async function getNotificationSettings() {
  const snapshot = await db.doc('notificationSettings/admin').get();
  const saved = snapshot.exists ? snapshot.data() : {};
  const events = {};

  for (const [name, defaults] of Object.entries(DEFAULT_EVENTS)) {
    const configured = saved.events && saved.events[name];
    events[name] = {
      inApp: configured && typeof configured.inApp === 'boolean'
        ? configured.inApp
        : defaults.inApp,
      email: configured && typeof configured.email === 'boolean'
        ? configured.email
        : defaults.email
    };
  }

  const configuredEmails = Array.isArray(saved.adminEmails)
    ? saved.adminEmails.map(normalizedEmail).filter(Boolean)
    : [];
  return {
    events,
    adminEmails: [...new Set(snapshot.exists && Array.isArray(saved.adminEmails)
      ? configuredEmails
      : [DEFAULT_ADMIN_EMAIL])]
  };
}

async function createInboxItem(uid, id, notification) {
  if (!uid) return;
  const ref = db.doc(`userNotifications/${uid}/items/${id}`);
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return;
    transaction.create(ref, {
      ...notification,
      uid,
      read: false,
      createdAt: Timestamp.now()
    });
  });
}

async function queueEmail(email, id, subject, text) {
  const to = normalizedEmail(email);
  if (!to) return;
  const ref = db.collection('mail').doc(id);
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return;
    transaction.create(ref, {
      to,
      message: { subject, text },
      createdAt: FieldValue.serverTimestamp()
    });
  });
}

async function sendEvent({
  event,
  sourceId,
  title,
  body,
  recipients,
  adminRecipients = false
}) {
  const settings = await getNotificationSettings();
  const channels = settings.events[event];
  if (!channels) return;

  const uniqueRecipients = new Map();
  for (const recipient of recipients) {
    if (!recipient || typeof recipient !== 'object') continue;
    const uid = typeof recipient.uid === 'string' ? recipient.uid : '';
    const email = normalizedEmail(recipient.email);
    const key = uid || email;
    if (key && !uniqueRecipients.has(key)) uniqueRecipients.set(key, { uid, email });
  }

  const deliveries = [];
  for (const recipient of uniqueRecipients.values()) {
    const key = safeId(recipient.uid || recipient.email);
    const id = `${safeId(sourceId)}_${key}`;
    if (channels.inApp && recipient.uid) {
      deliveries.push(createInboxItem(recipient.uid, id, {
        event,
        title,
        body
      }));
    }
    if (channels.email && recipient.email) {
      deliveries.push(queueEmail(recipient.email, id, title, body));
    }
  }
  if (adminRecipients && channels.email) {
    for (const email of settings.adminEmails) {
      const id = `${safeId(sourceId)}_admin_${safeId(email)}`;
      deliveries.push(queueEmail(email, id, title, body));
    }
  }
  await Promise.all(deliveries);
}

async function getAdminUsers(emails) {
  const users = [];
  for (const email of emails) {
    try {
      const user = await getAuth().getUserByEmail(email);
      users.push({ uid: user.uid, email: user.email || email });
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        console.warn(`No Firebase Auth account exists for notification administrator ${email}.`);
        continue;
      }
      throw error;
    }
  }
  return users;
}

async function getApprovedUsers() {
  const snapshot = await db.collection('rosterAccess').where('approved', '==', true).get();
  return snapshot.docs.map(document => {
    const data = document.data();
    return {
      uid: document.id,
      email: normalizedEmail(data.email)
    };
  }).filter(user => user.uid);
}

exports.notifyNewAccessRequest = onDocumentCreated(
  'rosterAccessRequests/{uid}',
  async event => {
    const request = event.data && event.data.data();
    if (!request || request.status !== 'pending') return;

    const settings = await getNotificationSettings();
    const admins = await getAdminUsers([...new Set([DEFAULT_ADMIN_EMAIL, ...settings.adminEmails])]);
    const name = typeof request.displayName === 'string' ? request.displayName : request.email;
    await sendEvent({
      event: 'newAccessRequest',
      sourceId: event.id,
      title: 'New roster access request',
      body: `${name || 'A user'} requested roster access.`,
      recipients: admins.map(admin => ({ uid: admin.uid })),
      adminRecipients: true
    });
  }
);

exports.notifyAccessStatusChange = onDocumentUpdated(
  'rosterAccessRequests/{uid}',
  async event => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (!after || before.status === after.status) return;

    const eventNames = {
      approved: 'accessApproved',
      rejected: before.status === 'approved' ? 'accessRevoked' : 'accessDeclined'
    };
    const notificationEvent = eventNames[after.status];
    if (!notificationEvent) return;

    const titleByEvent = {
      accessApproved: 'Roster access approved',
      accessDeclined: 'Roster access request declined',
      accessRevoked: 'Roster access revoked'
    };
    const bodyByEvent = {
      accessApproved: 'Your account can now access the published roster.',
      accessDeclined: 'Your roster access request was declined.',
      accessRevoked: 'Your roster access has been revoked.'
    };
    await sendEvent({
      event: notificationEvent,
      sourceId: event.id,
      title: titleByEvent[notificationEvent],
      body: bodyByEvent[notificationEvent],
      recipients: [{
        uid: event.params.uid,
        email: after.email || before.email
      }]
    });
  }
);

exports.notifyRosterPublished = onDocumentCreated(
  'rosterPublishes/{publishId}',
  async event => {
    const publication = event.data && event.data.data();
    if (!publication) return;
    const label = typeof publication.weekLabel === 'string'
      ? publication.weekLabel
      : 'a new week';
    const recipients = await getApprovedUsers();
    await sendEvent({
      event: 'rosterPublished',
      sourceId: event.id,
      title: 'New roster published',
      body: `The ${label} roster is now available.`,
      recipients
    });
  }
);

exports.notifyAnnouncement = onDocumentWritten(
  'systemSettings/{settingsId}',
  async event => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const announcement = typeof after.announcement === 'string' ? after.announcement.trim() : '';
    if (!announcement || announcement === before.announcement) return;

    const recipients = await getApprovedUsers();
    await sendEvent({
      event: 'announcement',
      sourceId: event.id,
      title: 'Roster announcement',
      body: announcement.slice(0, 500),
      recipients
    });
  }
);

function nairobiDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

exports.backupPublishedRosters = onSchedule(
  {
    schedule: '0 2 * * 0',
    timeZone: 'Africa/Nairobi',
    timeoutSeconds: 300
  },
  async () => {
    const rosterSnapshots = await Promise.all(
      ROSTER_IDS.map(id => db.collection('rosters').doc(id).get())
    );
    if (rosterSnapshots.some(snapshot => !snapshot.exists)) {
      throw new Error('Scheduled backup cancelled because one or more published rosters are missing.');
    }

    const dateKey = nairobiDateKey(new Date());
    const backupRef = db.collection('scheduledRosterBackups').doc(dateKey);
    const rosters = Object.fromEntries(
      rosterSnapshots.map(snapshot => [snapshot.id, snapshot.data()])
    );
    await backupRef.set({
      dateKey,
      createdAt: FieldValue.serverTimestamp(),
      rosters
    });

    const oldBackups = await db.collection('scheduledRosterBackups')
      .orderBy('createdAt', 'desc')
      .offset(RETAINED_BACKUPS)
      .get();
    if (!oldBackups.empty) {
      const batch = db.batch();
      oldBackups.docs.forEach(snapshot => batch.delete(snapshot.ref));
      await batch.commit();
    }
  }
);
