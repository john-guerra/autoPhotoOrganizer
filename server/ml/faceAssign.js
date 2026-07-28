/**
 * Filing newly-found faces under the people who already have names (#167).
 *
 * ## Why this exists at all
 *
 * `assignToPerson` was written for "the everyday case as photos arrive" and
 * then never called — dead code an independent review found. Without it the
 * ONLY route from a new photo to a person is a full re-cluster, which is the
 * O(n^2) pass over the whole library, to file the six faces that arrived this
 * morning. Worse, a re-cluster rebuilds every UNNAMED person from scratch, so
 * the cost of adding one photo was reshuffling all of them.
 *
 * So this runs after each sweep: new faces join the people the user has
 * NAMED, and nothing else moves.
 *
 * ## Named people only
 *
 * An unnamed cluster is the model's own guess. Growing it silently compounds
 * whatever it got wrong, and there is nobody to notice — a name is precisely
 * the user saying "this cluster is a person", which is what makes it worth
 * extending. Everyone else waits for the next grouping pass, where they can be
 * revised as a whole.
 *
 * A face that matches nobody stays unassigned. That is a real answer, not a
 * failure: forcing it into the nearest person is how a stranger ends up in
 * someone's photo set, which is far harder to spot and undo than a match that
 * was missed.
 */
import { assignToPerson, SAME_PERSON_COSINE } from "./faceClusters.js";
import {
  namedPersonMembers,
  unassignedFaces,
  attachFaces,
} from "../db/faces.js";

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {{threshold?: number}} [opts]
 * @returns {{assigned: number, people: number}} `people` is how many named
 *   people gained at least one face — the number worth reporting, since
 *   "assigned 40" says nothing about whether that was one person or twenty.
 */
export function assignNewFaces(db, model, { threshold } = {}) {
  const people = namedPersonMembers(db, model);
  if (!people.length) return { assigned: 0, people: 0 };
  const faces = unassignedFaces(db, model);
  if (!faces.length) return { assigned: 0, people: 0 };

  const pairs = [];
  const touched = new Set();
  for (const face of faces) {
    const hit = assignToPerson(face, people, threshold ?? SAME_PERSON_COSINE);
    if (!hit) continue;
    pairs.push({ faceId: face.id, personId: hit.personId });
    touched.add(hit.personId);
  }
  if (!pairs.length) return { assigned: 0, people: 0 };
  // Deliberately does NOT feed the new faces back into `people` as it goes.
  // Each match would widen the person's mean slightly, the next match would
  // widen it further, and a run of borderline faces could walk a person's
  // centroid onto somebody else — drift with nothing to stop it. Every face
  // in this pass is scored against the same fixed definition of each person.
  return { ...attachFaces(db, pairs), people: touched.size };
}
