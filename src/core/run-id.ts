import { randomBytes } from "node:crypto";

/**
 * One value per process, computed once at module load and re-exported from
 * `src/index.ts` so BOTH backend modules import the SAME value rather than
 * each computing their own. This is a correctness requirement, not a style choice: the
 * msb orphan reaper (`sweepOrphans`) and the docker label cleanup both
 * filter container names/labels against `RunId.value` to distinguish "this
 * run's own live containers" from "leftovers of a crashed prior run." If a
 * backend computed its own run id instead of importing this one, the two
 * values would differ and the reaper would either delete this run's own
 * containers (treating them as someone else's orphan) or never clean up the
 * other backend's leftovers at all — a silent correctness failure, not a
 * compile error.
 */
export const RunId: {
  /** 8 lowercase hex characters, stable for the lifetime of this process. */
  readonly value: string;
} = {
  value: randomBytes(4).toString("hex"),
};
