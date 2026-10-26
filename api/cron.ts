/**
 * GET /api/cron
 *
 * Server-side cron — runs every minute via Vercel Cron.
 * This is the ONLY place that expires grace periods and removes users from queue.
 * Clients do NOT call grace-timeout for "expired" — only the cron does.
 *
 * Tasks:
 *   1. Grace period expiry  — removes users who didn't scan within 5 min (ONCE per expiry)
 *   2. Incident timeout     — triggers buzzer if no admin response in 60s
 *
 * Protected by CRON_SECRET_KEY env var.
 * vercel.json schedule: "* * * * *"
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rtdb, incidentsRef, getCommandsRef, db } from '../lib/firebase';
import { getNextUser, removeUserFromQueue, updateNextUserId } from '../lib/queue';
import { notifyYourTurn, sendAndStoreNotification, storeNotification, sendNotification } from '../lib/fcm';
import { startGracePeriod, expireGracePeriod, startClothesGrace, expireClothesGrace } from '../lib/grace';
import type { GracePeriod, ClothesGracePeriod, Incident } from '../lib/types';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const results = {
    gracePeriods: { processed: [] as string[], errors: [] as string[] },
    incidents:    { processed: [] as string[], errors: [] as string[] },
  };

  // ─────────────────────────────────────────────
  // TASK 1: Grace Period Expiry
  // ─────────────────────────────────────────────
  try {
    const now      = new Date().toISOString();
    const snapshot = await rtdb.ref('gracePeriods').get();

    if (snapshot.exists()) {
      const gracePeriods = snapshot.val() as Record<string, GracePeriod>;

      for (const [machineId, gp] of Object.entries(gracePeriods)) {
        try {
          if (gp.status !== 'active') continue;
          if (gp.expiresAt > now) continue; // not expired yet

          console.log(`[Cron] Grace expired: ${machineId} user=${gp.userId}`);

          // Mark expired — clients watching RTDB will dismiss modals + stop alarms
          await expireGracePeriod(machineId);

          // Remove from queue — ONCE, only here
          await removeUserFromQueue(machineId, gp.userId);

          // Notify removed user — ONCE
          await sendAndStoreNotification({
            userId:   gp.userId,
            type:     'removed_from_queue',
            title:    '❌ Removed from Queue',
            body:     `You were removed from Machine ${machineId} queue due to timeout.`,
            data:     { machineId },
            priority: 'normal',
          });

          // Promote next user
          await updateNextUserId(machineId);
          const nextUser = await getNextUser(machineId);

          if (nextUser) {
            await startGracePeriod(machineId, nextUser.userId, nextUser.name || 'Unknown');
            await notifyYourTurn(nextUser.userId, machineId);
            await sendAndStoreNotification({
              userId:   nextUser.userId,
              type:     'your_turn',
              title:    '🎉 Your Turn!',
              body:     `Machine ${machineId} is ready. You have 5 minutes!`,
              data:     { machineId },
              sound:    'alarm',
              priority: 'high',
            });
            results.gracePeriods.processed.push(`${machineId}: expired ${gp.userId}, promoted ${nextUser.userId}`);
          } else {
            results.gracePeriods.processed.push(`${machineId}: expired ${gp.userId}, queue empty`);
          }
        } catch (err: any) {
          console.error(`[Cron] Grace error for ${machineId}:`, err);
          results.gracePeriods.errors.push(`${machineId}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error('[Cron] Grace period scan failed:', err);
    results.gracePeriods.errors.push(`scan_failed: ${err.message}`);
  }

  // ─────────────────────────────────────────────
  // TASK 2: Incident Timeout
  // ─────────────────────────────────────────────
  try {
    const now = new Date().toISOString();

    // Handle owner_pending timeouts → history = Unauthorized
    const ownerExpired = await incidentsRef
      .where('status', '==', 'owner_pending')
      .where('expiresAt', '<=', now)
      .get();

    for (const docSnap of ownerExpired.docs) {
      try {
        const incident   = docSnap.data() as Incident;
        const incidentId = docSnap.id;
        const ownerUserId = incident.ownerUserId || (incident as any).nextUserId;

        await incidentsRef.doc(incidentId).update({
          status:          'timeout',
          resolvedAt:      now,
          buzzerTriggered: false,
          resolvedBy:      'cron',
        });

        // Clear RTDB owner signal + Firestore incidentSignals doc
        await Promise.allSettled([
          rtdb.ref(`userIncident/${ownerUserId}`).remove(),
          db.collection('incidentSignals').doc(ownerUserId).delete(),
        ]);

        // Write Unauthorized history
        try {
          const histSnap = await db.collection('usageHistory')
            .where('incidentId', '==', incidentId).limit(1).get();
          if (!histSnap.empty) {
            await histSnap.docs[0].ref.update({ resultStatus: 'Unauthorized', updatedAt: now });
          } else {
            await db.collection('usageHistory').add({
              userId: incident.intruderId, userName: incident.intruderName,
              machineId: incident.machineId,
              startTime: (incident as any).confirmedAt || incident.createdAt || now,
              endTime: now, duration: 0, resultStatus: 'Unauthorized',
              incidentId, createdAt: now,
            });
          }
        } catch {}

        // Notify admins
        await sendAndStoreNotification({
          userId:   ownerUserId,
          type:     'buzzer_triggered',
          title:    '🚨 Incident Timed Out',
          body:     `No response for Machine ${incident.machineId}. Logged as Unauthorized.`,
          data:     { machineId: incident.machineId, incidentId },
          priority: 'normal',
        });

        results.incidents.processed.push(`${incidentId}: owner_pending timeout → Unauthorized`);
      } catch (err: any) {
        results.incidents.errors.push(`${docSnap.id}: ${err.message}`);
      }
    }

    // Handle pre_pending timeouts → silent close (intruder never confirmed)
    const preExpired = await incidentsRef
      .where('status', '==', 'pre_pending')
      .where('expiresAt', '<=', now)
      .get();

    for (const docSnap of preExpired.docs) {
      try {
        await incidentsRef.doc(docSnap.id).update({
          status: 'timeout', resolvedAt: now, buzzerTriggered: false, resolvedBy: 'cron',
        });
        results.incidents.processed.push(`${docSnap.id}: pre_pending timeout → silent`);
      } catch (err: any) {
        results.incidents.errors.push(`${docSnap.id}: ${err.message}`);
      }
    }

    // Legacy: handle old 'pending' status incidents (backward compat)
    const legacyExpired = await incidentsRef
      .where('status', '==', 'pending')
      .where('expiresAt', '<=', now)
      .get();

    for (const docSnap of legacyExpired.docs) {
      try {
        const incident = docSnap.data() as Incident;
        await incidentsRef.doc(docSnap.id).update({
          status: 'timeout', resolvedAt: now, buzzerTriggered: false, resolvedBy: 'cron',
        });
        await getCommandsRef(incident.machineId).update({
          buzzer: true, buzzerAt: now, buzzerReason: 'incident_timeout',
        });
        results.incidents.processed.push(`${docSnap.id}: legacy pending timeout`);
      } catch (err: any) {
        results.incidents.errors.push(`${docSnap.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error('[Cron] Incident scan failed:', err);
    results.incidents.errors.push(`scan_failed: ${err.message}`);
  }

  // ─────────────────────────────────────────────
  // TASK 3: Clothes Inside → Start Collection Grace
  // Detects RTDB iot/{machineId}/state === 'Clothes Inside'
  // and starts a 5-min collection grace if one doesn't exist yet.
  // ─────────────────────────────────────────────
  const clothesResults = { processed: [] as string[], errors: [] as string[] };
  try {
    const [iotSnap, clothesGraceSnap] = await Promise.all([
      rtdb.ref('iot').get(),
      rtdb.ref('clothesGrace').get(),
    ]);

    if (iotSnap.exists()) {
      const iotData = iotSnap.val() as Record<string, any>;
      const existingGraces = clothesGraceSnap.exists()
        ? (clothesGraceSnap.val() as Record<string, any>)
        : {};

      for (const [machineId, iotMachine] of Object.entries(iotData)) {
        try {
          if (iotMachine?.state !== 'Clothes Inside') continue;

          const existing = existingGraces[machineId];
          // Already have an active or collecting grace — skip
          if (existing && (existing.status === 'active' || existing.status === 'collecting')) continue;

          // Need to know who the current user is
          const currentUserId = iotMachine?.currentUserId;
          if (!currentUserId) continue;

          // Fetch user name
          const userSnap = await db.collection('users').doc(currentUserId).get();
          if (!userSnap.exists) continue;
          const userData = userSnap.data()!;
          const userName = userData.displayName || userData.name || 'Unknown';

          // Start the clothes collection grace
          await startClothesGrace(machineId, currentUserId, userName);

          // Notify the current user — alarm sound
          await storeNotification(currentUserId, 'clothes_ready',
            '👕 Clothes Ready!',
            `Your laundry at Machine ${machineId} is done. Please collect your clothes within 5 minutes.`,
            { machineId });
          sendNotification({
            userId: currentUserId, type: 'clothes_ready',
            title: '👕 Clothes Ready!',
            body: `Your laundry at Machine ${machineId} is done. Please collect your clothes within 5 minutes.`,
            data: { machineId }, sound: 'alarm', priority: 'high',
          }).catch(() => {});

          // Notify all admins — so they can monitor whether clothes are collected
          const adminsSnap = await db.collection('users').where('role', '==', 'admin').get();
          const adminNotifyPromises = adminsSnap.docs
            .filter(doc => doc.id !== currentUserId)
            .map(async doc => {
              await storeNotification(doc.id, 'clothes_collecting',
                `👁️ Clothes Ready – Machine ${machineId}`,
                `${userName}'s laundry is done. They have 5 minutes to collect.`,
                { machineId, userId: currentUserId, userName });
              sendNotification({
                userId: doc.id, type: 'clothes_collecting',
                title: `👁️ Clothes Ready – Machine ${machineId}`,
                body: `${userName}'s laundry is done. They have 5 minutes to collect.`,
                data: { machineId, userId: currentUserId, userName },
                priority: 'high',
              }).catch(() => {});
            });
          await Promise.all(adminNotifyPromises);

          clothesResults.processed.push(`${machineId}: clothes grace started for ${currentUserId}`);
        } catch (err: any) {
          console.error(`[Cron] Clothes grace error for ${machineId}:`, err);
          clothesResults.errors.push(`${machineId}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error('[Cron] Clothes Inside scan failed:', err);
    clothesResults.errors.push(`scan_failed: ${err.message}`);
  }

  // ─────────────────────────────────────────────
  // TASK 4: Clothes Grace Expiry
  // ─────────────────────────────────────────────
  try {
    const now = new Date().toISOString();
    const clothesSnap = await rtdb.ref('clothesGrace').get();
    if (clothesSnap.exists()) {
      const graces = clothesSnap.val() as Record<string, ClothesGracePeriod>;
      for (const [machineId, cg] of Object.entries(graces)) {
        try {
          if (cg.status !== 'active' && cg.status !== 'collecting') continue;
          if (cg.expiresAt > now) continue;
          await expireClothesGrace(machineId);
          clothesResults.processed.push(`${machineId}: clothes grace expired for ${cg.userId}`);
        } catch (err: any) {
          clothesResults.errors.push(`${machineId}_expire: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    clothesResults.errors.push(`expire_scan_failed: ${err.message}`);
  }

  // ─────────────────────────────────────────────
  // TASK 5: Machine Liveness Check
  // If iot/{machineId}/lastPing is older than OFFLINE_THRESHOLD_MS,
  // set isLive: false so the app reflects offline status accurately.
  // Threshold matches frontend: 90 seconds.
  // ─────────────────────────────────────────────
  const OFFLINE_THRESHOLD_MS = 90_000;
  const livenessResults = { processed: [] as string[], errors: [] as string[] };
  try {
    const iotSnap = await rtdb.ref('iot').get();
    if (iotSnap.exists()) {
      const iotData = iotSnap.val() as Record<string, any>;
      const nowMs = Date.now();
      const updates: Record<string, boolean> = {};

      for (const [machineId, data] of Object.entries(iotData)) {
        try {
          const lastPing: number = data?.lastPing ?? 0;
          const isStale = nowMs - lastPing > OFFLINE_THRESHOLD_MS;
          const currentlyLive: boolean = data?.isLive ?? false;

          // Only write when state needs to change — avoid unnecessary RTDB writes
          if (isStale && currentlyLive) {
            updates[`iot/${machineId}/isLive`] = false;
            livenessResults.processed.push(`${machineId}: offline (${Math.round((nowMs - lastPing) / 1000)}s since ping)`);
          } else if (!isStale && !currentlyLive) {
            // Machine came back online — flip it live again
            updates[`iot/${machineId}/isLive`] = true;
            livenessResults.processed.push(`${machineId}: back online`);
          }
        } catch (err: any) {
          livenessResults.errors.push(`${machineId}: ${err.message}`);
        }
      }

      // Single batched RTDB write for all changes
      if (Object.keys(updates).length > 0) {
        await rtdb.ref().update(updates);
      }
    }
  } catch (err: any) {
    console.error('[Cron] Liveness check failed:', err);
    livenessResults.errors.push(`scan_failed: ${err.message}`);
  }

  res.status(200).json({
    success:   true,
    timestamp: new Date().toISOString(),
    gracePeriods: {
      processed: results.gracePeriods.processed.length,
      errors:    results.gracePeriods.errors.length,
      details:   results.gracePeriods,
    },
    incidents: {
      processed: results.incidents.processed.length,
      errors:    results.incidents.errors.length,
      details:   results.incidents,
    },
    clothesGrace: {
      processed: clothesResults.processed.length,
      errors:    clothesResults.errors.length,
      details:   clothesResults,
    },
    liveness: {
      processed: livenessResults.processed.length,
      errors:    livenessResults.errors.length,
      details:   livenessResults,
    },
  });
}