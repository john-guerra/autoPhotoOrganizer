import { describe, it, expect, vi } from "vitest";
import { releaseVideo } from "./releaseVideo.js";

/**
 * Releasing a video element (#305).
 *
 * Normally "asserts the three calls happen" would be testing the
 * implementation rather than the behaviour. Here the three calls ARE the
 * behaviour: the HTML media-load algorithm aborts an in-flight fetch only when
 * `load()` runs after the source has changed, and nothing observable in JSDOM
 * can stand in for "the socket was released". The real measurement lives in
 * the issue (health check 1 ms → 4 s timeout → 2 ms); this is what keeps
 * someone from quietly deleting one of the three lines later.
 */

/** A video element with just enough surface, recording the order of calls. */
function fakeVideo() {
  const calls = [];
  return {
    calls,
    attrs: { src: "/api/image/62" },
    pause: () => calls.push("pause"),
    removeAttribute(name) {
      calls.push(`removeAttribute:${name}`);
      delete this.attrs[name];
    },
    load: () => calls.push("load"),
  };
}

describe("releaseVideo", () => {
  it("pauses, drops the source, and RE-RUNS the load algorithm, in that order", () => {
    const v = fakeVideo();
    expect(releaseVideo(v)).toBe(true);
    expect(v.calls).toEqual(["pause", "removeAttribute:src", "load"]);
  });

  it("REMOVES the src attribute rather than blanking it", () => {
    // `src = ""` resolves against the document URL, so the element goes off and
    // requests the PAGE — a new request instead of no request. It is the
    // classic near-miss for this exact fix.
    const v = fakeVideo();
    releaseVideo(v);
    expect("src" in v.attrs).toBe(false);
  });

  it("calls load() AFTER the source is gone, or nothing is aborted", () => {
    // Order is the whole mechanism: load() re-runs the media-load algorithm
    // against whatever the source is at that moment. Run it first and it
    // simply restarts the same fetch.
    const v = fakeVideo();
    releaseVideo(v);
    expect(v.calls.indexOf("load")).toBeGreaterThan(
      v.calls.indexOf("removeAttribute:src")
    );
  });

  it("never throws — it runs while Svelte is destroying the block", () => {
    const exploding = {
      pause: () => {},
      removeAttribute: () => {
        throw new Error("detached");
      },
      load: () => {},
    };
    expect(() => releaseVideo(exploding)).not.toThrow();
    // It could not abort the fetch, and it says so rather than reporting a
    // connection freed that is still open.
    expect(releaseVideo(exploding)).toBe(false);
  });

  it("ignores a missing element instead of guessing", () => {
    expect(releaseVideo(null)).toBe(false);
    expect(releaseVideo(undefined)).toBe(false);
    expect(releaseVideo({})).toBe(false);
  });

  it("STILL releases when pause() throws — the pause is the nicety", () => {
    // The first version wrapped all three in one try, so a throwing `pause()`
    // skipped the two calls that actually abort the fetch — putting #305 back
    // for that clip. Its test asserted `calls == []` and was titled "still
    // releases", i.e. it documented the broken behaviour as intended. Caught
    // in review.
    const v = fakeVideo();
    v.pause = () => {
      throw new Error("gone");
    };
    expect(releaseVideo(v)).toBe(true);
    expect(v.calls).toEqual(["removeAttribute:src", "load"]);
    expect("src" in v.attrs).toBe(false);
  });
});
