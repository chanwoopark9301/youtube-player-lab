import { randomBytes } from 'node:crypto';

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_LISTS = 500;
const validVideo = value => typeof value === 'string' && value.length === 11 && /^[A-Za-z0-9_-]{11}$/.test(value);
const validResult = value => typeof value === 'string' && value.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(value);

export class RecommendationError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'RecommendationError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status, message) {
  throw new RecommendationError(code, status, message);
}

/** Keeps only an expiring ordered list of video IDs, never conversation data. */
export class RecommendationLists {
  #lists = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#now = now;
  }

  create(videoIds) {
    const ids = Array.isArray(videoIds) ? [...videoIds] : null;
    if (!ids || ids.length < 1 || ids.length > 8 || !ids.every(validVideo) || new Set(ids).size !== ids.length) {
      fail('invalid_list', 400, 'A recommendation list requires one to eight distinct valid video IDs.');
    }
    const now = this.#now();
    for (const [id, list] of this.#lists) {
      if (list.expiresAt <= now) {
        // Keep only bounded expiry records for a useful 410 until a slot is needed.
        list.videoIds = [];
        if (this.#lists.size >= MAX_LISTS) this.#lists.delete(id);
      }
    }
    if (this.#lists.size >= MAX_LISTS) fail('capacity', 429, 'Recommendation list capacity reached.');
    let resultId;
    do { resultId = randomBytes(32).toString('base64url'); } while (this.#lists.has(resultId));
    const expiresAt = now + TTL_MS;
    this.#lists.set(resultId, { videoIds: ids, expiresAt });
    return { resultId, expiresAt };
  }

  resolve(resultId, itemNumber) {
    if (!validResult(resultId)) fail('invalid_result_id', 400, 'A valid recommendation result ID is required.');
    if (!Number.isInteger(itemNumber) || itemNumber < 1 || itemNumber > 8) {
      fail('invalid_item_number', 400, 'Choose a recommendation item number from one to eight.');
    }
    const list = this.#lists.get(resultId);
    if (!list) fail('not_found', 404, 'Recommendation list not found.');
    if (list.expiresAt <= this.#now()) {
      list.videoIds = [];
      fail('expired', 410, 'Recommendation list expired. Request new recommendations.');
    }
    if (itemNumber > list.videoIds.length) fail('invalid_item_number', 400, 'The selected recommendation item does not exist.');
    return list.videoIds[itemNumber - 1];
  }
}
