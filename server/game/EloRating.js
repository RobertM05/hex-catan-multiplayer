/**
 * EloRating.js
 * Multiplayer Elo rating calculator for 4-player ranked Catan.
 * 
 * Rules:
 * - 4-player pairwise comparison against the match field.
 * - 1st and 2nd place always gain rating (clamped >= +1).
 * - 3rd and 4th place always lose rating (clamped <= -1).
 * - Abandoners receive the full 4th-place Elo penalty.
 * - Minimum rating floor (default 100).
 * - Default starting rating: 1000.
 */

export const DEFAULT_ELO = 1000;
export const MIN_ELO = 100;
export const BASE_K = 16;

/**
 * Expected score of player A against player B
 * E_AB = 1 / (1 + 10^((R_B - R_A) / 400))
 */
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Calculate Elo delta for a single player against a set of opponent ratings.
 * @param {number} playerRating - The rating of the player
 * @param {number[]} opponentRatings - Array of ratings of opponents in the match
 * @param {number} rank - Finished rank (1, 2, 3, or 4)
 * @param {number} K - Scaling factor (default BASE_K)
 * @returns {number} The integer rating change (+ or -)
 */
export function calculatePlayerEloDelta(playerRating, opponentRatings, rank, K = BASE_K) {
  let totalExpected = 0;
  for (const opp of opponentRatings) {
    totalExpected += expectedScore(playerRating, opp);
  }

  // In a 4-player match with 3 opponents:
  // 1st place beats 3 opponents (actual = 3.0)
  // 2nd place beats 2 opponents (actual = 2.0)
  // 3rd place beats 1 opponent (actual = 1.0)
  // 4th place beats 0 opponents (actual = 0.0)
  const opponentCount = Math.max(1, opponentRatings.length);
  const totalActual = Math.max(0, opponentCount - (rank - 1));

  let delta = Math.round(K * (totalActual - totalExpected));

  // Product rule guarantees (Issue #122):
  // Finish 1–2: rating up (delta >= 1)
  // Finish 3–4: rating down (delta <= -1)
  if (rank === 1 || rank === 2) {
    delta = Math.max(1, delta);
  } else {
    delta = Math.min(-1, delta);
  }

  return delta;
}

/**
 * Calculate full match rating updates for all 4 players based on finish order.
 * @param {Array<{ userId: string, elo: number, rank: number, abandoned?: boolean }>} players
 * @param {number} K
 * @returns {Array<{ userId: string, oldElo: number, newElo: number, delta: number, rank: number, abandoned: boolean }>}
 */
export function calculateMatchEloUpdates(players, K = BASE_K) {
  if (!Array.isArray(players) || players.length === 0) return [];

  return players.map((p, i) => {
    const currentElo = Number(p.elo) || DEFAULT_ELO;
    // Abandoned players are treated as 4th place
    const effectiveRank = p.abandoned ? 4 : (p.rank || 4);
    const opponentRatings = players
      .filter((_, idx) => idx !== i)
      .map(x => Number(x.elo) || DEFAULT_ELO);

    const delta = calculatePlayerEloDelta(currentElo, opponentRatings, effectiveRank, K);
    const newElo = Math.max(MIN_ELO, currentElo + delta);

    return {
      userId: p.userId,
      oldElo: currentElo,
      newElo,
      delta,
      rank: effectiveRank,
      abandoned: Boolean(p.abandoned)
    };
  });
}

/**
 * Calculate the exact 4th-place Elo penalty for an abandoner against the initial match field.
 * @param {number} playerRating
 * @param {number[]} initialFieldRatings - All 4 initial players' ratings
 * @param {number} K
 * @returns {number} The penalty delta (guaranteed <= -1)
 */
export function calculateAbandonPenalty(playerRating, initialFieldRatings, K = BASE_K) {
  const currentElo = Number(playerRating) || DEFAULT_ELO;
  const oppRatings = [...initialFieldRatings];
  const selfIdx = oppRatings.indexOf(playerRating);
  if (selfIdx !== -1) {
    oppRatings.splice(selfIdx, 1);
  } else if (oppRatings.length >= 4) {
    oppRatings.pop();
  }

  const delta = calculatePlayerEloDelta(currentElo, oppRatings, 4, K);
  return Math.min(-1, delta);
}
