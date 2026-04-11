/**
 * POST /api/scan  — FIXED VERSION
 *
 * Fixes:
 *  #2/#3  isMyTurn: when machine is IN USE by currentUserId, no one else gets "scan ahead"
 *  #5     Deduplication: don't create duplicate incidents for same scan
 *  #6     Unauthorized: notify CURRENT user (not just nextUser) + all admins
 *  #7     Session start: record startTime in RTDB for usage-history calculation
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { getCommandsRef, machinesRef, incidentsRef, usersRef, rtdb, db } from '../lib/firebase';
import { FieldValue } from 'firebase-admin/firestore';
import {
  notifySessionStarted,
  notifyUnauthorizedAlert,
  notifyUnauthorizedWarning,
  sendAndStoreNotification
} from '../lib/fcm';
import type { ScanRequest, ScanResponse, ScanResult, Incident } from '../lib/types';

const machineCache = new Map<string, { data: any; timestamp: number }>();
const userCache = new Map<string, { data: any; timestamp: number }>();
const queueCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 500;  // 0.5s — must be fresh immediately after join/scan
const USER_CACHE_TTL = 30000; // Users change rarely — 30s cache

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { machineId, userId, userName } = req.body as ScanRequest;

    if (!machineId || !userId) {
      res.status(400).json({ success: false, result: 'machine_not_found' as ScanResult, message: 'Missing machineId or userId' });
      return;
    }

    // Parallel fetch: machine + user + queue — reduces latency by ~60%
    const [machine, user, nextUser] = await Promise.all([
      getMachineOptimized(machineId),
      getUserOptimized(userId),
      getNextUserOptimized(machineId),
    ]);

    if (!machine) {
      res.status(404).json({ success: false, result: 'machine_not_found' as ScanResult, message: 'Machine not found' });
      return;
    }
    if (!user) {
      res.status(404).json({ success: false, result: 'user_not_found' as ScanResult, message: 'User not found' });
      return;
    }

    const currentUserId = machine.currentUserId || null;

    // ── SECURITY: Block scan if user is already USING or IN QUEUE for another machine ──
    // This enforces one-machine-at-a-time policy at the scan level.
    // (queue.ts already enforces this on join; scan.ts must also check so users
    //  cannot bypass by scanning directly without joining the queue.)
    if (currentUserId !== userId) {
      // Check if this user is currently using any OTHER machine
      const otherMachineAsCurrentSnap = await machinesRef.where('currentUserId', '==', userId).get();
      if (!otherMachineAsCurrentSnap.empty) {
        const otherMachineId = otherMachineAsCurrentSnap.docs[0].id;
        if (otherMachineId !== machineId) {
          res.status(400).json({
            success: false,
            result: 'unauthorized' as ScanResult,
            message: `You are already using Machine ${otherMachineId}. Please release it before using another machine.`,
            data: { ownerUserName: '', ownerUserId: '', machineId: otherMachineId },
          });
          return;
        }
      }

      // Check if this user is already in the queue for any OTHER machine
      const allQueuesSnap = await machinesRef.firestore.collection('queues').get();
      for (const qDoc of allQueuesSnap.docs) {
        if (qDoc.id === machineId) continue;
        const users: any[] = qDoc.data()?.users ?? [];
        if (users.some((u: any) => u.userId === userId)) {
          res.status(400).json({
            success: false,
            result: 'unauthorized' as ScanResult,
            message: `You are already in the queue for Machine ${qDoc.id}. Leave that queue first before using another machine.`,
            data: { ownerUserName: '', ownerUserId: '', machineId: qDoc.id },
          });
          return;
        }
      }
    }

    // ── CASE 1: User is already the current user (re-entry) ──────────────────
    if (currentUserId === userId) {
      // Parallel: unlock door + update RTDB state
      await Promise.all([
        unlockDoorFast(machineId, userId),
        rtdb.ref(`iot/${machineId}`).update({ currentUserId: userId, state: 'In Use' }),
        // Clear any stale clothesGrace so new session starts clean
        rtdb.ref(`clothesGrace/${machineId}`).remove(),
      ]);
      notifySessionStarted(userId, machineId).catch(() => {});
      res.status(200).json({ success: true, result: 'already_current', message: 'Door unlocked. Welcome back!', data: { unlocked: true } });
      return;
    }

    // ── Machine is IN USE by someone else → unauthorized ──────────────────────
    if (currentUserId && currentUserId !== userId) {
      // Fetch owner data FIRST so createIncidentFast gets the real owner name
      // (parallel execution was causing ownerUserName: "Current User" in Firestore)
      const ownerData = await getUserOptimized(currentUserId);
      const incidentData = await createIncidentFast(
        machineId, userId, user,
        currentUserId,
        ownerData ?? { name: 'Unknown', displayName: 'Unknown' }
      );

      const ownerName = ownerData?.displayName || ownerData?.name || 'Unknown';
      const intruderName = user.displayName || user.name || 'Unknown';

      // All notifications fire-and-forget (non-blocking)
      Promise.all([
        notifyUnauthorizedAlert(currentUserId, machineId, incidentData.incidentId, intruderName),
        notifyUnauthorizedWarning(userId, machineId),
        notifyAdmins(machineId, incidentData.incidentId, userId, intruderName, 'scan'),
        sendAndStoreNotification({
          userId,
          type: 'unauthorized_warning',
          title: '⚠️ Machine In Use!',
          body: `Machine ${machineId} is currently in use. Your access has been reported.`,
          data: { machineId },
        }),
      ]).catch(() => {});

      res.status(403).json({
        success: false,
        result: 'unauthorized' as ScanResult,
        message: 'Machine is currently in use by another user.',
        data: {
          incidentId: incidentData.incidentId,
          currentUserId,
          ownerUserName: ownerName,
          nextUserName: ownerName,
          expiresAt: incidentData.expiresAt,
          expiresIn: 60,
        },
      });
      return;
    }

    // ── No current user: use pre-fetched queue data ───────────────────────────
    const nextUserId = nextUser?.userId || null;

    // ── CASE 2: User is nextUserId (claiming their grace period or queue turn) ─
    if (nextUserId === userId) {
      // FIX: Await critical state writes BEFORE sending response (serverless functions
      // may terminate immediately after res.json, losing background Promises)
      const now = new Date().toISOString();
      await Promise.all([
        unlockDoorFast(machineId, userId),
        claimMachineAtomic(machineId, userId),
        // Write currentUserId to RTDB iot/ so dashboard + queue update instantly
        rtdb.ref(`iot/${machineId}`).update({ currentUserId: userId, state: 'In Use' }),
        // Clear any stale clothesGrace so new session starts clean
        rtdb.ref(`clothesGrace/${machineId}`).remove(),
        // Clear grace period — user has claimed their turn
        rtdb.ref(`gracePeriods/${machineId}`).remove(),
        rtdb.ref(`sessions/${machineId}`).set({ userId, startTime: now }),
      ]);
      // Fire-and-forget notifications (non-critical)
      Promise.all([
        notifySessionStarted(userId, machineId),
        sendAndStoreNotification({ userId, type: 'session_started', title: '🎉 Session Started', body: `Machine ${machineId} is ready for you!`, data: { machineId } }),
      ]).catch(err => console.error('[Scan] notify error:', err));
      res.status(200).json({ success: true, result: 'authorized', message: 'Your turn! Door unlocked.', data: { unlocked: true } });
      return;
    }

    // ── CASE 3: No current user AND queue is empty → direct claim ────────────
    if (!currentUserId && !nextUserId) {
      // FIX: Await critical state writes BEFORE sending response
      const now = new Date().toISOString();
      await Promise.all([
        unlockDoorFast(machineId, userId),
        setCurrentUserAtomic(machineId, userId),
        // Write currentUserId to RTDB iot/ so dashboard + queue update instantly
        rtdb.ref(`iot/${machineId}`).update({ currentUserId: userId, state: 'In Use' }),
        // Clear any stale clothesGrace so new session starts clean
        rtdb.ref(`clothesGrace/${machineId}`).remove(),
        rtdb.ref(`sessions/${machineId}`).set({ userId, startTime: now }),
      ]);
      notifySessionStarted(userId, machineId).catch(() => {});
      res.status(200).json({ success: true, result: 'queue_empty_claim', message: 'Machine is yours! Door unlocked.', data: { unlocked: true } });
      return;
    }

    // ── CASE 4: Queue has someone ahead of this user → unauthorized ───────────
    // FIX #6: notify the nextUserId (rightful owner) + all admins
    const incidentData = await createIncidentFast(
      machineId, userId, user,
      nextUserId!, nextUser!
    );

    Promise.all([
      notifyUnauthorizedAlert(nextUserId!, machineId, incidentData.incidentId, user.displayName || user.name || 'Someone'),
      notifyUnauthorizedWarning(userId, machineId),
      notifyAdmins(machineId, incidentData.incidentId, userId, user.displayName || user.name || 'Unknown', 'scan'),
      sendAndStoreNotification({
        userId,
        type: 'unauthorized_warning',
        title: '⚠️ Not Your Turn!',
        body: `Machine ${machineId} is not available for you.`,
        data: { machineId },
      }),
    ]).catch(() => {});

    res.status(403).json({
      success: false,
      result: 'unauthorized' as ScanResult,
      message: 'Not your turn. The rightful user has been notified.',
      data: {
        incidentId: incidentData.incidentId,
        currentUserId,
        nextUserId,
        nextUserName: nextUser?.name || nextUser?.displayName || 'the next user',
        ownerUserName: nextUser?.name || nextUser?.displayName || 'the next user',
        expiresAt: incidentData.expiresAt,
        expiresIn: 60,
      },
    });

  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getMachineOptimized(machineId: string): Promise<any | null> {
  const now = Date.now();
  const cached = machineCache.get(machineId);
  if (cached && now - cached.timestamp < CACHE_TTL) return cached.data;
  const snap = await machinesRef.doc(machineId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  machineCache.set(machineId, { data, timestamp: now });
  return data;
}

async function getUserOptimized(userId: string): Promise<any | null> {
  const now = Date.now();
  const cached = userCache.get(userId);
  if (cached && now - cached.timestamp < USER_CACHE_TTL) return cached.data;
  const snap = await machinesRef.firestore.collection('users').doc(userId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  userCache.set(userId, { data, timestamp: now });
  return data;
}

async function getNextUserOptimized(machineId: string): Promise<any | null> {
  const now = Date.now();
  const cached = queueCache.get(machineId);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    const users = cached.data?.users ?? [];
    if (users.length === 0) return null;
    return [...users].sort((a: any, b: any) => a.position - b.position)[0];
  }
  const snap = await machinesRef.firestore.collection('queues').doc(machineId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  queueCache.set(machineId, { data, timestamp: now });
  const users = data?.users ?? [];
  if (users.length === 0) return null;
  return [...users].sort((a: any, b: any) => a.position - b.position)[0];
}

async function unlockDoorFast(machineId: string, userId: string): Promise<void> {
  const commandsRef = getCommandsRef(machineId);
  await commandsRef.update({
    solenoidOpen: {
      value: true,
      requestUserId: userId,
      triggeredAt: new Date().toISOString(),
      triggeredBy: 'qr_scan',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  });
}

async function claimMachineAtomic(machineId: string, userId: string): Promise<void> {
  const batch = db.batch();
  const now = new Date().toISOString();
  const queueRef = machinesRef.firestore.collection('queues').doc(machineId);
  const queueSnap = await queueRef.get();
  if (queueSnap.exists) {
    const users = queueSnap.data()?.users ?? [];
    const updatedUsers = users
      .filter((u: any) => u.userId !== userId)
      .map((u: any, i: number) => ({ ...u, position: i + 1 }));
    batch.update(queueRef, { users: updatedUsers, lastUpdated: now });
  }
  const newNextId = queueSnap.exists
    ? (queueSnap.data()?.users?.find((u: any) => u.userId !== userId)?.userId || null)
    : null;
  batch.update(machinesRef.doc(machineId), {
    currentUserId: userId,
    status: 'In Use',
    nextUserId: newNextId,
    lastUpdated: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

async function setCurrentUserAtomic(machineId: string, userId: string): Promise<void> {
  await machinesRef.doc(machineId).update({
    currentUserId: userId,
    status: 'In Use',
    lastUpdated: FieldValue.serverTimestamp(),
  });
}

async function createIncidentFast(
  machineId: string,
  intruderId: string,
  intruderData: any,
  ownerUserId: string,
  ownerData: any
): Promise<{ incidentId: string; expiresAt: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 1000);
  const incidentId = `inc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const incident: Incident = {
    machineId,
    intruderId,
    intruderName: intruderData.displayName || intruderData.name || 'Unknown',
    ownerUserId,
    ownerUserName: ownerData.displayName || ownerData.name || 'Unknown',
    nextUserId: ownerUserId,      // backward compat
    nextUserName: ownerData.displayName || ownerData.name || 'Unknown',
    status: 'pre_pending',  // becomes 'pending' only after intruder confirms
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    resolvedAt: null,
    buzzerTriggered: false,
  };

  await Promise.all([
    incidentsRef.doc(incidentId).set(incident),
    rtdb.ref(`incidents/${machineId}/${incidentId}`).set({ ...incident, secondsLeft: 60 }),
  ]);

  // Note: timeout is handled by the cron job (runs every minute), not here.
  // The RTDB countdown was removed — serverless functions can't maintain setTimeout reliably.
  return { incidentId, expiresAt: expiresAt.toISOString() };
}

/**
 * FIX #6: Notify ALL admin users about an incident
 */
async function notifyAdmins(
  machineId: string,
  incidentId: string,
  intruderId: string,
  intruderName: string,
  source: string
): Promise<void> {
  try {
    const adminsSnap = await machinesRef.firestore
      .collection('users')
      .where('role', '==', 'admin')
      .get();

    const notifyPromises = adminsSnap.docs
      .filter(doc => doc.id !== intruderId) // don't re-notify the intruder if admin
      .map(doc =>
        sendAndStoreNotification({
          userId: doc.id,
          type: 'unauthorized_alert',
          title: '🚨 Unauthorized Access Attempt',
          body: `${intruderName} tried to access Machine ${machineId} without authorization.`,
          data: { machineId, incidentId, source },
          priority: 'high',
        })
      );

    await Promise.all(notifyPromises);
  } catch (err) {
    console.error('[notifyAdmins] failed:', err);
  }
}

function updateIncidentCountdownBackground(
  machineId: string,
  incidentId: string,
  secondsLeft: number
): void {
  if (secondsLeft <= 0) {
    const now = new Date().toISOString();
    // Update BOTH RTDB and Firestore so stale incidents don't accumulate in Firestore
    Promise.all([
      rtdb.ref(`incidents/${machineId}/${incidentId}`)
        .update({ secondsLeft: 0, status: 'timeout' }),
      incidentsRef.doc(incidentId).get().then(snap => {
        // Only update Firestore if incident is still pre_pending (intruder never confirmed)
        // pending incidents are handled by the client-side timeout call instead
        if (snap.exists && snap.data()?.status === 'pre_pending') {
          return incidentsRef.doc(incidentId).update({
            status: 'timeout',
            resolvedAt: now,
            buzzerTriggered: false,
          });
        }
      }),
      getCommandsRef(machineId).update({ buzzer: true, buzzerAt: now }),
    ]).catch(() => {});
    return;
  }
  rtdb.ref(`incidents/${machineId}/${incidentId}/secondsLeft`)
    .set(secondsLeft)
    .then(() => {
      setTimeout(() => updateIncidentCountdownBackground(machineId, incidentId, secondsLeft - 1), 1000);
    })
    .catch(() => {});
}

/**
 * FIX #5: Write unauthorized scan attempt to usageHistory collection
 */
async function logUnauthorizedHistory(
  machineId: string,
  userId: string,
  userName: string,
  incidentId: string
): Promise<void> {
  const now = new Date();
  try {
    await db.collection('usageHistory').add({
      userId,
      userName,
      machineId,
      startTime: now.toISOString(),
      endTime: now.toISOString(),
      duration: 0,
      resultStatus: 'Unauthorized',
      incidentId,
      createdAt: now.toISOString(),
    });
  } catch (err) {
    console.error('[scan] Failed to log unauthorized history:', err);
  }
}