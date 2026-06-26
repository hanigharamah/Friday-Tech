import { authorize } from '../modules/authorization.js';
import { settle } from '../modules/settlement.js';
import { reverseAuthorization } from '../modules/reversal.js';
import { FuelGrade } from '@prisma/client';

export type PumpSessionStatus = 'AUTHORIZED' | 'DISPENSED' | 'ABORTED';

export interface PumpSession {
  id: string;
  authorizationId: string;
  tagUid: string;
  stationCode: string;
  grade: FuelGrade;
  maxMillilitres: number;
  status: PumpSessionStatus;
  createdAt: Date;
  authResult: Record<string, unknown>;
  settleResult: Record<string, unknown> | null;
  reversalResult: Record<string, unknown> | null;
}

const sessions = new Map<string, PumpSession>();

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function pumpScan(params: {
  tagUid: string;
  stationCode: string;
  grade: FuelGrade;
  targetMillilitres?: number;
}): Promise<PumpSession> {
  const { tagUid, stationCode, grade } = params;

  const authResult = await authorize({ tagUid, stationCode, grade });

  const cappedMax = params.targetMillilitres
    ? Math.min(params.targetMillilitres, authResult.max_millilitres)
    : authResult.max_millilitres;

  const session: PumpSession = {
    id: newId(),
    authorizationId: authResult.authorization_id,
    tagUid,
    stationCode,
    grade,
    maxMillilitres: cappedMax,
    status: 'AUTHORIZED',
    createdAt: new Date(),
    authResult: authResult as unknown as Record<string, unknown>,
    settleResult: null,
    reversalResult: null,
  };

  sessions.set(session.id, session);
  return session;
}

export async function pumpDispense(sessionId: string, millilitres?: number): Promise<PumpSession> {
  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error('Pump session not found'), { statusCode: 404 });
  if (session.status !== 'AUTHORIZED') {
    throw Object.assign(
      new Error(`Cannot dispense in session status ${session.status}`),
      { statusCode: 409 }
    );
  }

  const ml = millilitres ?? session.maxMillilitres;
  const settleResult = await settle({ authorizationId: session.authorizationId, millilitresDispensed: ml });

  session.status = 'DISPENSED';
  session.settleResult = settleResult as unknown as Record<string, unknown>;
  return session;
}

export async function pumpAbort(sessionId: string): Promise<PumpSession> {
  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error('Pump session not found'), { statusCode: 404 });
  if (session.status !== 'AUTHORIZED') {
    throw Object.assign(
      new Error(`Cannot abort session in status ${session.status}`),
      { statusCode: 409 }
    );
  }

  const reversalResult = await reverseAuthorization(session.authorizationId);

  session.status = 'ABORTED';
  session.reversalResult = reversalResult as unknown as Record<string, unknown>;
  return session;
}

export function getSession(sessionId: string): PumpSession {
  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error('Pump session not found'), { statusCode: 404 });
  return session;
}
