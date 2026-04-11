/**
 * Firebase Cloud Messaging Helper
 *
 * Sound mapping (must match Android res/raw/ and iOS Bundle):
 *   calling.mp3  → incoming voice/video calls
 *   alarm.mp3    → grace period (your_turn), unauthorized alert, clothes ready
 *   urgent.mp3   → unauthorized warning, grace warning/expiry
 *   notify.mp3   → chat messages
 *   default      → queue updates, session start/end, missed call
 *
 * Android channel → sound:
 *   calls    → calling.mp3   (bypassDnd: true)
 *   critical → alarm.mp3    (bypassDnd: true)
 *   urgent   → urgent.mp3
 *   chat     → notify.mp3
 *   queue    → default
 *   default  → default
 *
 * Killed-app delivery:
 *   - Expo token path: uses exp.host API with channelId + sound
 *   - Native FCM path: uses notification + data payload (not data-only)
 *     Data-only messages are silent on killed Android apps.
 */

import { messaging, usersRef, notificationsRef } from './firebase';
import * as admin from 'firebase-admin';

export type NotificationType =
  | 'your_turn'
  | 'grace_warning'
  | 'removed_from_queue'
  | 'unauthorized_alert'
  | 'unauthorized_warning'
  | 'buzzer_triggered'
  | 'clothes_ready'
  | 'clothes_collecting'
  | 'session_started'
  | 'session_ended'
  | 'queue_joined'
  | 'queue_left'
  | 'chat_message'
  | 'voice_call'
  | 'video_call'
  | 'missed_call'
  | 'missed_video';

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default' | 'alarm' | 'calling' | 'urgent' | 'notify';
  priority?: 'normal' | 'high';
  channelId?: string;
}

// ── Sound + channel resolution ─────────────────────────────────────────────

/** Maps notification type to { soundFile, channelId } */
function resolveAudio(type: NotificationType, overrideSound?: string, overrideChannel?: string): {
  soundFile: string;
  channelId: string;
} {
  // Explicit overrides take precedence
  if (overrideChannel && overrideSound) {
    return { soundFile: soundFileFor(overrideSound), channelId: overrideChannel };
  }

  switch (type) {
    // Incoming calls → calling.mp3 / calls channel
    case 'voice_call':
    case 'video_call':
      return { soundFile: 'calling.mp3', channelId: 'calls' };

    // Grace alarm + unauthorized alert + clothes ready → alarm.mp3 / critical
    case 'your_turn':
    case 'unauthorized_alert':
    case 'clothes_ready':
    case 'clothes_collecting':
      return { soundFile: 'alarm.mp3', channelId: 'critical' };

    // Warnings → urgent.mp3 / urgent channel
    case 'grace_warning':
    case 'unauthorized_warning':
    case 'removed_from_queue':
      return { soundFile: 'urgent.mp3', channelId: 'urgent' };

    // Chat → notify.mp3 / chat channel
    case 'chat_message':
      return { soundFile: 'notify.mp3', channelId: 'chat' };

    // Queue updates → default / queue channel
    case 'queue_joined':
    case 'queue_left':
    case 'session_started':
    case 'session_ended':
    case 'buzzer_triggered':
      return { soundFile: 'default', channelId: 'queue' };

    // Missed calls → default / default channel (low importance)
    case 'missed_call':
    case 'missed_video':
    default:
      return { soundFile: 'default', channelId: overrideChannel || 'default' };
  }
}

function soundFileFor(sound: string): string {
  switch (sound) {
    case 'alarm':   return 'alarm.mp3';
    case 'calling': return 'calling.mp3';
    case 'urgent':  return 'urgent.mp3';
    case 'notify':  return 'notify.mp3';
    default:        return 'default';
  }
}

// ── Token retrieval ────────────────────────────────────────────────────────

async function getUserFcmToken(userId: string): Promise<string | null> {
  try {
    const userDoc = await usersRef.doc(userId).get();
    if (!userDoc.exists) return null;
    return userDoc.data()?.fcmToken || null;
  } catch (error) {
    console.error(`Failed to get FCM token for user ${userId}:`, error);
    return null;
  }
}

// ── Main send function ─────────────────────────────────────────────────────

export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  const {
    userId,
    type,
    title,
    body,
    data = {},
    sound,
    priority = 'high',
    channelId,
  } = payload;

  try {
    const fcmToken = await getUserFcmToken(userId);
    if (!fcmToken) {
      console.warn(`No FCM token for user ${userId}`);
      return false;
    }

    const { soundFile, channelId: resolvedChannel } = resolveAudio(type, sound, channelId);

    // ── Expo push token path ───────────────────────────────────────────────
    if (fcmToken.startsWith('ExponentPushToken')) {
      const message: Record<string, any> = {
        to: fcmToken,
        title,
        body,
        data: { type, ...data },
        priority: priority === 'high' ? 'high' : 'normal',
        badge: 1,
        // channelId maps to the Android notification channel registered in the app.
        // The channel defines which sound file plays on Android 8+.
        channelId: resolvedChannel,
        // iOS: use the actual sound file name (must be in the app bundle)
        sound: soundFile === 'default' ? 'default' : soundFile,
        // Ensure notification appears even when app is in foreground
        _displayInForeground: true,
        // iOS critical alerts for calls/alarms (requires entitlement)
        ...(resolvedChannel === 'calls' || resolvedChannel === 'critical'
          ? { _category: 'ALARM' }
          : {}),
      };

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Expo push failed: ${errorText}`);
      }

      const result = await response.json();
      // Log any per-message errors from Expo
      if (result?.data?.status === 'error') {
        console.error(`Expo push error for ${userId}:`, result.data.message);
      }

      console.log(`Expo notification sent to ${userId}: ${type} (channel=${resolvedChannel}, sound=${soundFile})`);
      return true;
    }

    // ── Native FCM path ────────────────────────────────────────────────────
    // IMPORTANT: Must include both `notification` AND `data` fields.
    // Data-only messages are NOT shown by Android when the app is killed.
    // The `notification` field triggers the system to display the notification
    // even with the app terminated.
    //
    // FULL-SCREEN INTENT: Android will automatically promote a MAX-importance
    // notification to a full-screen activity if:
    //  1. The app has USE_FULL_SCREEN_INTENT permission granted
    //  2. The notification channel has IMPORTANCE_HIGH or MAX
    //  3. The device is locked or the screen is off
    // We achieve this via the `calls` / `critical` channels (already MAX + bypassDnd).
    const isCallOrCritical = resolvedChannel === 'calls' || resolvedChannel === 'critical';
    // For voice/video calls: data-only (no notification field) so the FCM background
    // handler can intercept and show notifee full-screen intent. If notification field
    // is present, Android short-circuits and shows a system notification directly,
    // bypassing the background handler and preventing full-screen call UI.
    const isCallNotification = type === 'voice_call' || type === 'video_call';
    const message: admin.messaging.Message = {
      token: fcmToken,
      // data-only for calls — notifee background handler handles display
      ...(!isCallNotification ? { notification: { title, body } } : {}),
      // data field = available to the app when it opens
      data: {
        type,
        ...data,
        // Stringify all values — FCM data values must be strings
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        // Pass title + body in data as well so the background JS handler can
        // re-schedule with the correct content when Firebase auto-displays
        // the notification before the JS handler fires.
        title,
        body,
      },
      android: {
        priority: 'high', // always high so device wakes for critical alerts
        // time_to_live: 0 for calls — don't deliver a stale call notification
        ...(resolvedChannel === 'calls' ? { ttl: 0 } : {}),
        notification: {
          channelId: resolvedChannel,
          sound: soundFile === 'default' ? undefined : soundFile,
          defaultSound: soundFile === 'default',
          visibility: 'public',
          notificationCount: 1,
          localOnly: false,
          // For calls: set notification priority to MAX so Android auto-invokes
          // the full-screen intent (USE_FULL_SCREEN_INTENT) when screen is locked.
          notificationPriority: isCallOrCritical
            ? 'PRIORITY_MAX' as any
            : 'PRIORITY_DEFAULT' as any,
          ...(isCallOrCritical
            ? {
                sticky: resolvedChannel === 'calls',
                defaultVibrateTimings: false,
                vibrateTimingsMillis: [0, 500, 200, 500, 200, 500],
              }
            : { defaultVibrateTimings: true }),
        },
        // direct_boot_ok delivers even before device unlock (API 24+)
        directBootOk: isCallOrCritical,
      },
      apns: {
        headers: {
          'apns-priority': priority === 'high' ? '10' : '5',
          // apns-push-type must be 'alert' for visible notifications
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            // iOS sound: use critical alert for calls/alarms (requires entitlement)
            sound: resolvedChannel === 'calls' || resolvedChannel === 'critical'
              ? { critical: 1, name: soundFile === 'default' ? 'default' : soundFile, volume: 1.0 }
              : (soundFile === 'default' ? 'default' : soundFile),
            badge: 1,
            // content-available=1 wakes the app in background (needed for call handling)
            'content-available': 1,
            'mutable-content': 1,
            'interruption-level': (resolvedChannel === 'calls' || resolvedChannel === 'critical')
              ? 'critical'
              : 'active',
          },
        },
      },
    };

    await messaging.send(message);
    console.log(`Native FCM notification sent to ${userId}: ${type} (channel=${resolvedChannel}, sound=${soundFile})`);
    return true;
  } catch (error) {
    console.error(`Failed to send notification to ${userId}:`, error);
    return false;
  }
}

// ── Firestore storage ──────────────────────────────────────────────────────

export async function storeNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<string> {
  // Spread known extra fields (senderId, senderName, callerName, machineId) to root
  // so NotificationPopup can read them directly without digging into data{}
  const { senderId, senderName, callerName, machineId, ...rest } = data || {};
  const docRef = await notificationsRef.add({
    userId,
    type,
    title,
    body,
    data: rest,
    // Root-level fields for easy querying by NotificationPopup
    ...(senderId    ? { senderId }    : {}),
    ...(senderName  ? { senderName }  : {}),
    ...(callerName  ? { callerName }  : {}),
    ...(machineId   ? { machineId }   : {}),
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return docRef.id;
}

export async function sendAndStoreNotification(payload: NotificationPayload): Promise<{
  sent: boolean;
  notificationId: string;
}> {
  const [sent, notificationId] = await Promise.all([
    sendNotification(payload),
    storeNotification(payload.userId, payload.type, payload.title, payload.body, payload.data),
  ]);
  return { sent, notificationId };
}

// ── Convenience helpers ────────────────────────────────────────────────────

/** Your Turn — alarm.mp3, critical channel, bypasses DND */
export async function notifyYourTurn(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'your_turn',
    title: '🎉 Your Turn!',
    body: `Machine ${machineId} is ready for you. You have 5 minutes to scan the QR code.`,
    data: { machineId },
    priority: 'high',
  });
}

/** Grace warning — urgent.mp3, urgent channel */
export async function notifyGraceWarning(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'grace_warning',
    title: '⚠️ Hurry Up!',
    body: `Only 3 minutes left to claim Machine ${machineId}!`,
    data: { machineId },
    priority: 'high',
  });
}

/** Removed from queue — urgent.mp3 */
export async function notifyRemovedFromQueue(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'removed_from_queue',
    title: '❌ Removed from Queue',
    body: `You were removed from Machine ${machineId} queue due to timeout.`,
    data: { machineId },
    priority: 'normal',
  });
}

/** Unauthorized alert — alarm.mp3, critical channel, bypasses DND */
export async function notifyUnauthorizedAlert(
  userId: string,
  machineId: string,
  incidentId: string,
  intruderName: string
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'unauthorized_alert',
    title: '🚨 Someone at Your Machine!',
    body: `${intruderName} is trying to use Machine ${machineId}. Is this you?`,
    data: { machineId, incidentId, intruderName },
    priority: 'high',
  });
}

/** Unauthorized warning to intruder — urgent.mp3 */
export async function notifyUnauthorizedWarning(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'unauthorized_warning',
    title: '⚠️ Not Your Turn!',
    body: `Machine ${machineId} is not available for you. If you proceed, you will be reported.`,
    data: { machineId },
    priority: 'high',
  });
}

/** Buzzer triggered */
export async function notifyBuzzerTriggered(
  userId: string,
  machineId: string,
  reason: string
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'buzzer_triggered',
    title: '🚨 Alert Triggered',
    body: reason,
    data: { machineId },
    priority: 'high',
  });
}

/** Clothes ready — alarm.mp3, critical channel */
export async function notifyClothesReady(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'clothes_ready',
    title: '👕 Clothes Ready!',
    body: `Your laundry at Machine ${machineId} is done. Please collect your clothes.`,
    data: { machineId },
    priority: 'high',
  });
}

/** Session started — default sound */
export async function notifySessionStarted(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'session_started',
    title: '✅ Session Started',
    body: `You are now using Machine ${machineId}. Happy washing!`,
    data: { machineId },
    priority: 'normal',
  });
}

/** Session ended — default sound */
export async function notifySessionEnded(userId: string, machineId: string): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'session_ended',
    title: '👋 Session Ended',
    body: `Your session at Machine ${machineId} has ended.`,
    data: { machineId },
    priority: 'normal',
  });
}

/** Queue joined — default sound */
export async function notifyQueueJoined(userId: string, machineId: string, position: number): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'queue_joined',
    title: '✅ Joined Queue',
    body: `You are #${position} in line for Machine ${machineId}.`,
    data: { machineId, position: position.toString() },
    priority: 'normal',
  });
}

/** Chat message — notify.mp3, chat channel */
export async function notifyChatMessage(
  userId: string,
  senderName: string,
  message: string,
  machineId: string
): Promise<boolean> {
  const truncatedMessage = message.length > 50 ? message.substring(0, 50) + '...' : message;
  return sendNotification({
    userId,
    type: 'chat_message',
    title: `💬 ${senderName}`,
    body: truncatedMessage,
    data: { machineId, senderName },
    priority: 'high',
  });
}

/** Incoming voice call — calling.mp3, calls channel, bypasses DND */
export async function notifyIncomingVoiceCall(
  userId: string,
  callerName: string,
  callId: string,
  callerId: string = '',
  callerAvatar: string = ''
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'voice_call',
    title: '📞 Incoming Call',
    body: `${callerName} is calling you`,
    // CRITICAL: callerId + callerAvatar must be in data so that when user taps the
    // push notification from a killed/background state, the incoming call screen
    // receives all params it needs to accept/reject the call correctly.
    data: {
      callId,
      callerName,
      callerId,
      ...(callerAvatar ? { callerAvatar } : {}),
    },
    priority: 'high',
  });
}

/** Incoming video call — calling.mp3, calls channel, bypasses DND */
export async function notifyIncomingVideoCall(
  userId: string,
  callerName: string,
  callId: string,
  callerId: string = '',
  callerAvatar: string = ''
): Promise<boolean> {
  return sendNotification({
    userId,
    type: 'video_call',
    title: '📹 Incoming Video Call',
    body: `${callerName} is video calling you`,
    data: {
      callId,
      callerName,
      callerId,
      ...(callerAvatar ? { callerAvatar } : {}),
    },
    priority: 'high',
  });
}

/** Missed call — default sound + stored in Firestore so NotificationPopup shows it */
export async function notifyMissedCall(
  userId: string,
  callerName: string,
  isVideo: boolean = false
): Promise<boolean> {
  const type = isVideo ? 'missed_video' : 'missed_call';
  const title = isVideo ? '📹 Missed Video Call' : '📞 Missed Call';
  const body = `You missed a ${isVideo ? 'video ' : ''}call from ${callerName}`;
  
  // Store in Firestore so NotificationPopup fires in-app notification
  await storeNotification(userId, type, title, body, { callerName }).catch(() => {});
  
  return sendNotification({
    userId,
    type,
    title,
    body,
    data: { callerName },
    priority: 'normal',
  });
}
