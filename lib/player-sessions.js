import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 2 * 60 * 60 * 1000;
const STALE_MS = 15_000;
const MAX_SESSIONS = 500;
const MAX_COMMANDS = 20;
const STATES = new Set(['playing', 'paused', 'cued', 'ended', 'buffering', 'unstarted', 'error']);
const ACTIONS = new Set(['select', 'play', 'pause', 'seek']);
const validVideo = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest();

export class PlayerSessionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PlayerSessionError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new PlayerSessionError(status, code, message);
}

/** Ephemeral capabilities for a personal experiment, not account authentication. */
export class PlayerSessions {
  #sessions = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#now = now;
  }

  #retire(session, now) {
    if (!session.expired && session.expiresAt <= now) {
      // Retain a bounded tombstone for a useful 410, without retaining browser data.
      const expiresAt = session.expiresAt;
      for (const key of Object.keys(session)) delete session[key];
      Object.assign(session, { expiresAt, expired: true });
    }
    return session.expired === true;
  }

  #lookup(playerRef) {
    const session = this.#sessions.get(playerRef);
    if (!session) fail(404, 'not_found', 'Player session not found');
    if (this.#retire(session, this.#now())) fail(410, 'expired', 'Player session expired');
    return session;
  }

  #browser(playerRef, reportKey) {
    const session = this.#lookup(playerRef);
    const candidate = typeof reportKey === 'string' && reportKey.length <= 256 ? reportKey : '';
    if (!timingSafeEqual(hash(candidate), session.reportKeyHash)) fail(403, 'forbidden', 'Invalid browser capability');
    return session;
  }

  create(videoId) {
    if (!validVideo(videoId)) fail(400, 'invalid_video', 'A valid video ID is required');
    const now = this.#now();
    for (const [ref, session] of this.#sessions) {
      if (this.#retire(session, now) && this.#sessions.size >= MAX_SESSIONS) this.#sessions.delete(ref);
    }
    if (this.#sessions.size >= MAX_SESSIONS) fail(429, 'capacity', 'Player session capacity reached');
    let playerRef;
    do { playerRef = randomBytes(32).toString('base64url'); } while (this.#sessions.has(playerRef));
    const reportKey = randomBytes(32).toString('base64url');
    const expiresAt = now + TTL_MS;
    this.#sessions.set(playerRef, {
      expiresAt, reportKeyHash: hash(reportKey), epoch: null,
      requested: { videoId, revision: 1 }, commands: [], lastCommandId: 0,
      // IDs in one revision form a contiguous range, even after buffer eviction.
      revisionFirstCommandId: 1,
      observed: null, observedAt: null, observedEpoch: null, ack: null,
    });
    return { playerRef, reportKey, expiresAt };
  }

  attach(playerRef, reportKey) {
    const session = this.#browser(playerRef, reportKey);
    session.epoch = randomBytes(16).toString('base64url');
    return {
      epoch: session.epoch,
      revision: session.requested.revision,
      videoId: session.requested.videoId,
      afterCommandId: session.ack?.commandId ?? 0,
    };
  }

  queue(playerRef, input) {
    const session = this.#lookup(playerRef);
    if (!object(input) || !ACTIONS.has(input.action)) fail(400, 'invalid_command', 'Unsupported player command');
    const { action, videoId, seconds, expectedRevision } = input;
    if (expectedRevision !== undefined && !positiveInteger(expectedRevision)) fail(400, 'invalid_revision', 'Invalid expected revision');
    if (action === 'select' && !validVideo(videoId)) fail(400, 'invalid_video', 'A valid video ID is required');
    if (action !== 'select' && videoId !== undefined) fail(400, 'invalid_command', 'Only select accepts a video ID');
    if (action === 'seek' ? !validTime(seconds) : seconds !== undefined) fail(400, 'invalid_time', 'Seek time must be finite and between 0 and 86400');
    if (expectedRevision !== undefined && expectedRevision !== session.requested.revision) fail(409, 'revision_conflict', 'Player selection changed');
    const id = session.lastCommandId + 1;
    if (action === 'select') {
      session.requested = { videoId, revision: session.requested.revision + 1 };
      session.revisionFirstCommandId = id;
    }
    const command = { id, action, ...session.requested, createdAt: this.#now() };
    if (action === 'seek') command.seconds = seconds;
    session.lastCommandId = id;
    session.commands.push(command);
    if (session.commands.length > MAX_COMMANDS) {
      // A slow player still needs the latest selection before later play/seek commands.
      const first = session.commands[0];
      const preserveSelection = first.action === 'select' && first.revision === session.requested.revision;
      session.commands.splice(preserveSelection ? 1 : 0, 1);
    }
    return { ...command };
  }

  poll(playerRef, reportKey, epoch, afterCommandId = 0) {
    const session = this.#browser(playerRef, reportKey);
    if (!session.epoch || epoch !== session.epoch) return { commands: [], detached: true };
    if (!Number.isSafeInteger(afterCommandId) || afterCommandId < 0 || afterCommandId > session.lastCommandId) fail(400, 'invalid_cursor', 'Invalid command cursor');
    const commands = session.commands
      .filter(command => command.id > afterCommandId && command.revision === session.requested.revision)
      .map(command => ({ ...command }));
    return { commands, detached: false };
  }

  report(playerRef, reportKey, epoch, input) {
    const session = this.#browser(playerRef, reportKey);
    if (!session.epoch || epoch !== session.epoch) return false;
    if (!object(input)) return false;
    const { videoId, revision, state, currentTime, ackCommandId, error } = input;
    if (!validVideo(videoId) || !positiveInteger(revision) || !STATES.has(state) || !validTime(currentTime)) return false;
    if (videoId !== session.requested.videoId || revision !== session.requested.revision) return false;
    if (error !== undefined && (typeof error !== 'string' || error.length > 500)) return false;
    if (ackCommandId !== undefined) {
      if (!positiveInteger(ackCommandId) || ackCommandId < session.revisionFirstCommandId || ackCommandId > session.lastCommandId) return false;
      if (session.ack && ackCommandId < session.ack.commandId) return false;
    }
    session.observed = { videoId, revision, state, currentTime };
    if (error !== undefined) session.observed.error = error;
    session.observedAt = this.#now();
    session.observedEpoch = epoch;
    if (ackCommandId !== undefined) session.ack = { commandId: ackCommandId, revision };
    return true;
  }

  getState(playerRef) {
    const session = this.#lookup(playerRef);
    const ageMs = session.observedAt === null ? null : Math.max(0, this.#now() - session.observedAt);
    const stale = session.observed === null || session.observedEpoch !== session.epoch || session.observed.revision !== session.requested.revision || ageMs > STALE_MS;
    return {
      playerRef, expiresAt: session.expiresAt,
      requested: { ...session.requested },
      observed: session.observed === null ? null : { ...session.observed },
      observedAt: session.observedAt,
      ack: session.ack === null ? null : { ...session.ack },
      lastCommandId: session.lastCommandId,
      ageMs, stale, attached: session.epoch !== null,
    };
  }
}
