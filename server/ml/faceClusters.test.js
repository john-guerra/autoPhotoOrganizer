import { describe, it, expect } from "vitest";
import { quantize } from "./quantize.js";
import {
  clusterFaces,
  assignToPerson,
  SAME_PERSON_COSINE,
} from "./faceClusters.js";

const DIM = 64;

/** These fixtures exercise MECHANISM (linkage, the degree cap, mean scoring),
 *  not the tuned default. Pinning the threshold here keeps them from breaking
 *  every time SAME_PERSON_COSINE is retuned against real faces — which it was,
 *  from 0.5 to 0.8, and which broke three of them. */
const T = 0.5;

/** A vector pointing in a named direction, with `noise` pulling it off-axis.
 *  Same axis + small noise = the same person photographed twice. */
function vec(axis, noise = 0, seed = 0) {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  for (let i = 0; i < DIM; i++) {
    if (i !== axis) v[i] = noise * Math.sin(i * 3.1 + seed * 7.7);
  }
  return v;
}

/** Pack faces into the flat layout db/faces.js `faceVectors` returns. */
function pack(list) {
  const data = new Int8Array(list.length * DIM);
  const scales = new Float32Array(list.length);
  const ids = new Int32Array(list.length);
  list.forEach((v, i) => {
    const { scale, bytes } = quantize(v);
    data.set(bytes, i * DIM);
    scales[i] = scale;
    ids[i] = i + 1;
  });
  return { ids, scales, dim: DIM, data };
}

describe("clustering faces into people", () => {
  it("groups repeat sightings of one person and keeps two people apart", async () => {
    const v = pack([
      vec(0, 0.02, 1),
      vec(0, 0.03, 2),
      vec(0, 0.02, 3), // person A, three times
      vec(20, 0.02, 4),
      vec(20, 0.03, 5), // person B, twice
    ]);
    const { clusters } = await clusterFaces(v);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual([1, 2, 3]); // largest first
    expect(clusters[1]).toEqual([4, 5]);
  });

  it("leaves a face seen once as its own person, not merged into the nearest", async () => {
    // #167: "a person with no name should still be browsable". Forcing every
    // face into some cluster is exactly what k-means would do, and it puts a
    // stranger from the background of one photo into someone's photo set.
    const v = pack([vec(0, 0.02, 1), vec(0, 0.02, 2), vec(40, 0.01, 3)]);
    const { clusters } = await clusterFaces(v);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual([1, 2]);
    expect(clusters[1]).toEqual([3]); // alone, and still a person
  });

  it("orders clusters largest first, for naming", async () => {
    // Ten minutes spent on the biggest clusters covers most of a library; a
    // wall of unnamed singletons first is a chore rather than a feature.
    const v = pack([
      vec(30, 0.01, 1),
      vec(0, 0.02, 2),
      vec(0, 0.02, 3),
      vec(0, 0.02, 4),
      vec(0, 0.02, 5),
      vec(10, 0.02, 6),
      vec(10, 0.02, 7),
    ]);
    const sizes = (await clusterFaces(v)).clusters.map((c) => c.length);
    expect(sizes).toEqual([4, 2, 1]);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it("caps how many neighbours one face links through", async () => {
    // The transitivity hazard: single-linkage components chain, so one
    // promiscuous vector similar to everybody fuses every person in the
    // library into a single cluster. maxDegree is the cap that stops it.
    const many = Array.from({ length: 12 }, (_, i) => vec(0, 0.02, i));
    const v = pack(many);

    expect((await clusterFaces(v, { maxDegree: 1000 })).clusters).toHaveLength(
      1
    );
    // The cap partitions EXACTLY, and the exact shape is the assertion: a cap
    // applied to only one side of each pair (i but not j) lets a saturated
    // face keep accumulating links from new partners, which merges these back
    // together. "More than one cluster" would not notice that.
    const shape = async (d) =>
      (await clusterFaces(v, { maxDegree: d })).clusters.map((c) => c.length);
    expect(await shape(1)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(await shape(2)).toEqual([3, 3, 3, 3]);
    expect(await shape(3)).toEqual([4, 4, 4]);
  });

  it("stops one BRIDGE face from fusing two separate people", async () => {
    // The transitivity hazard made concrete, and the reason the cap exists at
    // all: a face similar to two different people links them, and single
    // linkage then makes them one person. In a real archive the bridge is a
    // small or blurry face -- which is also why MIN_FACE_PX drops those
    // before they ever reach here.
    const halfway = new Float32Array(DIM);
    halfway[0] = 0.72;
    halfway[20] = 0.72; // similar to BOTH axes, above the threshold for each
    const v = pack([
      vec(0, 0.02, 1),
      vec(0, 0.02, 2),
      vec(0, 0.02, 3),
      halfway,
      vec(20, 0.02, 4),
      vec(20, 0.02, 5),
      vec(20, 0.02, 6),
    ]);

    // Uncapped, the bridge swallows everybody into one "person".
    expect(
      (await clusterFaces(v, { maxDegree: 1000, threshold: T })).clusters
    ).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
    // Capped, the two people survive as two.
    expect(
      (await clusterFaces(v, { maxDegree: 3, threshold: T })).clusters
    ).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7],
    ]);
  });

  it("caps a bridge that is only ever the SECOND face of a pair", async () => {
    // The case the cap has to handle on BOTH sides. Here the bridge sorts
    // last, so it is never the outer loop's face -- it is only ever reached
    // as a candidate. Checking the cap on just the outer face would let the
    // bridge keep accepting links from person after person and fuse them all.
    const halfway = new Float32Array(DIM);
    halfway[0] = 0.72;
    halfway[20] = 0.72;
    const v = pack([
      vec(0, 0.02, 1),
      vec(0, 0.02, 2),
      vec(0, 0.02, 3),
      vec(20, 0.02, 4),
      vec(20, 0.02, 5),
      vec(20, 0.02, 6),
      halfway, // last
    ]);

    expect(
      (await clusterFaces(v, { maxDegree: 1000, threshold: T })).clusters
    ).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
    // The bridge joins ONE person and stops. Both people survive.
    expect(
      (await clusterFaces(v, { maxDegree: 3, threshold: T })).clusters
    ).toEqual([
      [1, 2, 3, 7],
      [4, 5, 6],
    ]);
  });

  it("is empty, not broken, with nothing to cluster", async () => {
    expect(
      await clusterFaces({ ids: [], scales: [], dim: 0, data: new Int8Array() })
    ).toEqual({ clusters: [], singletons: [] });
  });

  it("uses the int8 contract's scales rather than re-normalizing", async () => {
    // quantize() L2-normalizes BEFORE quantizing, so cosine is dot * both
    // scales. Recomputing norms here would be slower AND wrong.
    const a = new Float32Array(DIM);
    const b = new Float32Array(DIM);
    a[0] = 5; // deliberately unnormalized, and of different magnitudes
    b[0] = 0.01;
    const v = pack([a, b]);
    // Same direction, wildly different magnitude -> the same person.
    expect((await clusterFaces(v)).clusters).toEqual([[1, 2]]);
  });

  it("lets the event loop run while it scans", async () => {
    // The scan is O(n^2): ~10,700 faces in this library is 57 million dot
    // products, tens of seconds. Run straight through it is a server that
    // answers nothing -- no thumbnails, no feed, no jobs panel -- and the
    // user cannot tell a wedge from a crash. CLAUDE.md: heavy work never
    // blocks the event loop.
    //
    // setImmediate is a MACROTASK, so it cannot run while a synchronous loop
    // holds the thread, and it cannot run during an `await` of a plain value
    // either (that resumes on the microtask queue). A non-zero count here
    // therefore means real yields happened mid-scan.
    const v = pack(Array.from({ length: 600 }, (_, i) => vec(i % 30, 0.02, i)));
    let ticks = 0;
    const pump = () => {
      ticks++;
      if (ticks < 10_000) setImmediate(pump);
    };
    setImmediate(pump);

    await clusterFaces(v, { yieldEvery: 32 });
    const observed = ticks;
    ticks = 10_000; // stop the pump
    expect(observed).toBeGreaterThan(0);
  });

  it("separates at the threshold, not near it", async () => {
    // Orthogonal vectors have cosine 0, which must never clear the bar.
    const v = pack([vec(0), vec(1)]);
    expect((await clusterFaces(v)).clusters).toHaveLength(2);
    // ...and lowering the bar below zero merges them, proving the threshold
    // is what decides rather than something incidental.
    expect((await clusterFaces(v, { threshold: -1 })).clusters).toHaveLength(1);
  });
});

describe("assigning a new face as photos arrive", () => {
  const person = (personId, vectors) => ({
    personId,
    members: vectors.map((v) => quantize(v)),
  });

  it("picks the person it actually resembles", async () => {
    const A = person(1, [vec(0, 0.02, 1), vec(0, 0.02, 2)]);
    const B = person(2, [vec(20, 0.02, 3)]);
    const face = quantize(vec(20, 0.03, 9));

    expect(assignToPerson(face, [A, B])).toMatchObject({ personId: 2 });
  });

  it("returns null for a stranger rather than forcing the nearest", async () => {
    // A real answer, not a failure. Forcing it would put a stranger into
    // someone's photo set, which is far harder to notice and undo than a
    // missed match the user can merge in one click.
    const A = person(1, [vec(0, 0.02, 1)]);
    expect(assignToPerson(quantize(vec(40, 0.01, 5)), [A])).toBe(null);
  });

  it("scores against the whole person, not whichever member is first", async () => {
    // A person represented by twenty photos must not be decided by one
    // unflattering frame that happens to sort first. So person 1's FIRST
    // member is deliberately the worst of the three: scoring by first member
    // picks person 2, scoring by the mean picks person 1.
    const noisyFirst = person(1, [
      vec(0, 0.9, 1), // an unflattering frame
      vec(0, 0.01, 2),
      vec(0, 0.01, 3),
    ]);
    const moderate = person(2, [vec(0, 0.5, 9)]);
    const face = quantize(vec(0, 0.01, 7));

    const r = assignToPerson(face, [noisyFirst, moderate], T);
    expect(r).toMatchObject({ personId: 1 });
  });

  it("ignores a person with no members instead of dividing by zero", async () => {
    const empty = { personId: 3, members: [] };
    const A = person(1, [vec(0, 0.02, 1)]);
    const r = assignToPerson(quantize(vec(0, 0.02, 2)), [empty, A]);
    expect(r).toMatchObject({ personId: 1 });
    expect(Number.isNaN(r.score)).toBe(false);
  });

  it("respects the threshold it is given", async () => {
    const A = person(1, [vec(0, 0.02, 1)]);
    const face = quantize(vec(30, 0.02, 2));
    expect(assignToPerson(face, [A], SAME_PERSON_COSINE)).toBe(null);
    expect(assignToPerson(face, [A], -1)).toMatchObject({ personId: 1 });
  });
});
