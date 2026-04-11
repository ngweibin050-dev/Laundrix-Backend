// ─── Grace Period ──────────────────────────────────────────────────────────────

export interface GracePeriod {
  machineId: string;
  userId: string;
  userName: string;
  startedAt: string;
  expiresAt: string;
  warningAt: string;
  warningSent: boolean;
  status: 'active' | 'claimed' | 'expired';
}

// ─── Clothes Collection Grace Period ──────────────────────────────────────────
// Triggered when IoT machine sets state = 'Clothes Inside' in RTDB.
// Lives at RTDB path:  clothesGrace/{machineId}
// Separate from GracePeriod (which is for "your turn" scan-in flows).

export interface ClothesGracePeriod {
  machineId: string;
  userId: string;       // the current user who needs to collect
  userName: string;
  startedAt: string;   // ISO
  expiresAt: string;   // ISO  (startedAt + 5 min)
  warningSent: boolean;
  status: 'active' | 'collecting' | 'expired';
  // status transitions:
  //   'active'     → clothes inside, alarm ringing, label = "Preparing to collect"
  //   'collecting' → user dismissed the modal, label = "Collecting clothes"
  //   'expired'    → 5 min passed with no collection detected
}

// ─── Usage record ──────────────────────────────────────────────────────────────

export interface UsageRecord {
  id?: string;
  userId: string;
  userName: string;
  machineId: string;
  startTime: string;
  endTime: string;
  duration: number;
  resultStatus: 'Completed' | 'Unauthorized' | 'Timeout';
  incidentId?: string | null;
}

// ─── Incident ──────────────────────────────────────────────────────────────────

export interface Incident {
  machineId: string;
  intruderId: string;
  intruderName: string;
  ownerUserId: string;
  ownerUserName: string;
  nextUserId: string;       // backward compat alias for ownerUserId
  nextUserName: string;
  status: 'pre_pending'|'pending' | 'confirmed' | 'resolved' | 'dismissed' | 'timeout';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  buzzerTriggered: boolean;
}

// ─── Incident action request ───────────────────────────────────────────────────
// action values MUST match exactly what the frontend sends (api.ts + useIncidentHandler.ts)

export interface IncidentActionRequest {
  incidentId: string;
  userId: string;
  action: 'thats_me'|'admin_dismiss'|'admin_dismiss_false'|'confirm' | 'confirm_not_me' | 'dismiss' | 'timeout';
  cancelReason?: string;
}

// ─── Scan ──────────────────────────────────────────────────────────────────────

export interface ScanRequest {
  machineId: string;
  userId: string;
  userName?: string;
}

export interface ScanResponse {
  success: boolean;
  result: ScanResult;
  message: string;
  data?: any;
}

export type ScanResult =
  | 'authorized'
  | 'already_current'
  | 'queue_empty_claim'
  | 'unauthorized'
  | 'machine_not_found'
  | 'user_not_found';

// ─── Release request ──────────────────────────────────────────────────────────

export interface ReleaseRequest {
  machineId: string;
  userId: string;
}

// ─── Grace timeout request ────────────────────────────────────────────────────

export interface GraceTimeoutRequest {
  machineId: string;
  userId: string;
  timeoutType: 'warning' | 'expired';
}

// ─── Generic API response ─────────────────────────────────────────────────────

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  error?: string;
  data?: T;
}
