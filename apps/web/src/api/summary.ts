import { apiGet } from "./client";
import type { GameId, GameSummaryEntry, GamesSummary } from "./types";

const TTL_MS = 60_000;

let cached: { at: number; byGame: Map<GameId, GameSummaryEntry> } | null = null;
let inFlight: Promise<Map<GameId, GameSummaryEntry>> | null = null;

// All games' events + versions come from one shared /api/summary request so the
// Shell, HomePage and GamePage hooks never fan out into per-game fetches.
async function getSummaryByGame(): Promise<Map<GameId, GameSummaryEntry>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.byGame;

  let request = inFlight;
  if (!request) {
    request = apiGet<GamesSummary>("/api/summary")
      .then((res) => {
        const byGame = new Map<GameId, GameSummaryEntry>();
        for (const entry of res.data.games) byGame.set(entry.game, entry);
        cached = { at: Date.now(), byGame };
        return byGame;
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
  }
  return request;
}

export async function fetchGameSummaryEntry(game: GameId): Promise<GameSummaryEntry> {
  const byGame = await getSummaryByGame();
  return byGame.get(game) ?? { game, ok: false, error: "No data for game" };
}

// Drops the shared summary cache so the next fetch hits the network, e.g. when
// the user explicitly retries after a failure.
export function invalidateSummaryCache(): void {
  cached = null;
}
