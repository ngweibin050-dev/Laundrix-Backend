/**
 * POST /api/queue
 *
 * FIX — FCM always 1 action behind:
 *   Root cause: storeNotification (Firestore write the in-app list listens to)
 *   was inside backgroundTasks which ran AFTER res.json().
 *   Vercel terminates the function immediately after the response, so the
 *   Firestore write sometimes never completed, or completed after the next
 *   action's write — making the in-app list show action N+1 while FCM showed N.
 *
 *   Fix: storeNotification is AWAITED before res.json().
 *        sendNotification (FCM push) is fire-and-forget after.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import {
  getMachine,
  getUser,
  addUserToQueue,
  isUserInQueue,
  updateNextUserId,
  removeUserFromQueue,
} from '../lib/queue';
import { sendNotification, storeNotification } from '../lib/fcm';
import { rtdb } from '../lib/firebase';
import { startGracePeriod } from '../lib/grace';

interface QueueRequest {
  action: 'join' | 'leave';
  machineId: string;
  userId: string;
  userName?: string;
  idempotencyKey?: string;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const { action, machineId, userId, userName, idempotencyKey } =
    req.body as QueueRequest;

  if (!action || !machineId || !userId) {
    res.status(400).json({ success: false, error: 'Missing action, machineId, or userId' });
    return;
  }

  try {
    if (action === 'join')  return await handleJoin(req, res, machineId, userId, userName, idempotencyKey);
    if (action === 'leave') return await handleLeave(req, res, machineId, userId);
    res.status(400).json({ success: false, error: 'Invalid action. Use "join" or "leave"' });
  } catch (error) {
    console.error(`[queue/${action}] error:`, error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Join ─────────────────────────────────────────────────────────────────────

async function handleJoin(
  _req: VercelRequest,
  res: VercelResponse,
  machineId: string,
  userId: string,
  userName?: string,
  idempotencyKey?: string
): Promise<void> {
  const { machinesRef: mRef, queuesRef: qRef } = await import('../lib/firebase').then(m => ({
    machinesRef: m.machinesRef,
    queuesRef: m.queuesRef,
  }));

  const [machine, user, allMachinesSnap, allQueuesSnap] = await Promise.all([
    getMachine(machineId),
    getUser(userId),
    mRef.where('currentUserId', '==', userId).get(),
    qRef.get(),
  ]);

  if (!machine) { res.status(404).json({ success: false, error: 'Machine not found' }); return; }
  if (!user)    { res.status(404).json({ success: false, error: 'User not found' }); return; }
  if (machine.currentUserId === userId) {
    res.status(400).json({ success: false, error: 'You are currently using this machine', code: 'ALREADY_CURRENT_USER' });
    return;
  }

  const thisQueueDoc   = allQueuesSnap.docs.find((d: any) => d.id === machineId);
  const thisQueueUsers = (thisQueueDoc?.data()?.users ?? []) as any[];
  if (thisQueueUsers.some((u: any) => u.userId === userId)) {
    res.status(400).json({ success: false, error: 'Already in queue for this machine', code: 'ALREADY_IN_QUEUE' });
    return;
  }

  if (!allMachinesSnap.empty) {
    const otherMachineId = allMachinesSnap.docs[0].id;
    res.status(400).json({ success: false, error: `You are already using Machine ${otherMachineId}.`, code: 'ALREADY_USING_MACHINE' });
    return;
  }
  for (const qDoc of allQueuesSnap.docs) {
    if (qDoc.id === machineId) continue;
    const users = (qDoc.data()?.users ?? []) as any[];
    if (users.some((u: any) => u.userId === userId)) {
      res.status(400).json({ success: false, error: `Already in queue for Machine ${qDoc.id}.`, code: 'ALREADY_IN_OTHER_QUEUE' });
      return;
    }
  }

  const queueUser = await addUserToQueue(
    machineId,
    userId,
    userName || user.displayName || user.name || 'Unknown',
    user.photoURL || user.avatar || null,
    idempotencyKey
  );

  if (!queueUser) { res.status(500).json({ success: false, error: 'Failed to add to queue' }); return; }

  const isMachineFree  = !machine.currentUserId;
  const isFirstInQueue = queueUser.position === 1;
  const resolvedName   = userName || (user as any).displayName || (user as any).name || 'Unknown';

  // ── AWAIT before responding: Firestore store + RTDB grace must exist ─────
  // This guarantees in-app notification list is always up to date when the
  // client refreshes, and GraceAlarmModal finds the RTDB node immediately.
  await Promise.all([
    ...(isMachineFree && isFirstInQueue ? [startGracePeriod(machineId, userId, resolvedName)] : []),
    storeNotification(userId, 'queue_joined', '✅ Joined Queue',
      `You are #${queueUser.position} in line for Machine ${machineId}.`,
      { machineId, position: queueUser.position.toString() }),
    ...(isMachineFree && isFirstInQueue ? [
      storeNotification(userId, 'your_turn', '🎉 Your Turn!',
        `Machine ${machineId} is ready! You have 5 minutes to scan in.`,
        { machineId }),
    ] : []),
    ...(isFirstInQueue ? [] : [updateNextUserId(machineId)]),
  ]);

  console.log(`User ${userId} joined queue for ${machineId} at position ${queueUser.position}`);
  res.status(200).json({
    success: true,
    message: `Joined queue at position ${queueUser.position}`,
    data: { position: queueUser.position, queueToken: queueUser.queueToken, joinedAt: queueUser.joinedAt },
  });

  // ── FCM push AFTER response — best-effort, never causes lag ───────────────
  Promise.all([
    sendNotification({ userId, type: 'queue_joined', title: '✅ Joined Queue',
      body: `You are #${queueUser.position} in line for Machine ${machineId}.`,
      data: { machineId, position: queueUser.position.toString() } }),
    ...(isMachineFree && isFirstInQueue ? [
      sendNotification({ userId, type: 'your_turn', title: '🎉 Your Turn!',
        body: `Machine ${machineId} is ready! You have 5 minutes to scan in.`,
        data: { machineId }, sound: 'alarm', priority: 'high' }),
    ] : []),
  ]).catch(err => console.error('[queue/join] FCM error:', err));
}

// ─── Leave ────────────────────────────────────────────────────────────────────

async function handleLeave(
  _req: VercelRequest,
  res: VercelResponse,
  machineId: string,
  userId: string
): Promise<void> {
  const userInQueue = await isUserInQueue(machineId, userId);
  if (!userInQueue) { res.status(400).json({ success: false, error: 'Not in queue for this machine' }); return; }

  const removed = await removeUserFromQueue(machineId, userId);
  if (!removed) { res.status(500).json({ success: false, error: 'Failed to leave queue' }); return; }

  // ── AWAIT before responding: Firestore store always committed ────────────
  await Promise.all([
    updateNextUserId(machineId),
    storeNotification(userId, 'queue_left', '👋 Left Queue',
      `You've left the queue for Machine ${machineId}.`,
      { machineId }),
  ]);

  console.log(`User ${userId} left queue for ${machineId}`);
  res.status(200).json({ success: true, message: 'Successfully left the queue' });

  // ── FCM push AFTER response — best-effort ─────────────────────────────────
  sendNotification({ userId, type: 'queue_left', title: '👋 Left Queue',
    body: `You've left the queue for Machine ${machineId}.`, data: { machineId } })
    .catch(err => console.error('[queue/leave] FCM error:', err));
}
