// Character trial check-offs. A banner featuring several characters is checked off per
// character on game pages, so each character gets its own completion id
// (`<bannerId>#<name>`); a single-character banner keeps the banner id itself. A banner id
// stored before the split still counts as every one of its characters done.

export type CompletionId = string | number;

export type TrialUnit = {
  bannerId: CompletionId;
  partId: CompletionId;
  // Every part of the same banner, needed to keep the siblings checked when one part of a
  // banner stored under its plain id is unchecked.
  bannerPartIds: CompletionId[];
};

export function trialUnitsForBanner(bannerId: CompletionId, characters: readonly string[]): TrialUnit[] {
  if (characters.length <= 1) return [{ bannerId, partId: bannerId, bannerPartIds: [bannerId] }];
  const bannerPartIds = characters.map((name) => `${bannerId}#${name}`);
  return bannerPartIds.map((partId) => ({ bannerId, partId, bannerPartIds }));
}

export function isTrialUnitDone(completed: ReadonlySet<CompletionId> | undefined, unit: TrialUnit): boolean {
  if (!completed) return false;
  return completed.has(unit.partId) || completed.has(unit.bannerId);
}

export function areTrialUnitsDone(completed: ReadonlySet<CompletionId> | undefined, units: readonly TrialUnit[]): boolean {
  return units.length > 0 && units.every((unit) => isTrialUnitDone(completed, unit));
}

// Ids to flip so that every unit ends up checked (when not all are) or unchecked (when all are).
export function trialToggleIds(completed: ReadonlySet<CompletionId> | undefined, units: readonly TrialUnit[]): CompletionId[] {
  const before = new Set(completed ?? []);
  const next = new Set(before);
  if (!areTrialUnitsDone(before, units)) {
    for (const unit of units) if (!isTrialUnitDone(next, unit)) next.add(unit.partId);
  } else {
    for (const unit of units) {
      if (unit.partId !== unit.bannerId && next.has(unit.bannerId)) {
        // The banner was checked as a whole: keep its other characters checked individually.
        next.delete(unit.bannerId);
        for (const partId of unit.bannerPartIds) next.add(partId);
      }
    }
    for (const unit of units) next.delete(unit.partId);
  }
  const flips: CompletionId[] = [];
  for (const id of before) if (!next.has(id)) flips.push(id);
  for (const id of next) if (!before.has(id)) flips.push(id);
  return flips;
}
