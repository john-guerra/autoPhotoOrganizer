/**
 * The job -> scheduler wiring (#344).
 *
 * This file exists because the bug it covers was not IN any function: every
 * piece worked, and the four `scheduler.submit` call sites simply did not hand
 * the scheduler the one field that makes Cancel reach a parked run. No unit
 * test could see that (each unit was right) and no e2e test could either
 * (reproducing it needs a background sweep parked behind a scoped request on a
 * real library). Extracting the wiring into one object is what makes it
 * testable at all — which is half the reason for extracting it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { registry } from "./registry.js";
import { runFor, waitingFor } from "./scheduledJob.js";

afterEach(() => {
  for (const j of registry.list()) {
    if (j.status === "running") registry.fail(j.id, "cleanup");
    registry.dismiss(j.id);
  }
});

describe("runFor — what a job hands the scheduler", () => {
  it("carries the job's cancellation signal, which is the whole of #344", () => {
    const job = registry.create("faces", { label: "Finding faces" });
    const run = runFor(job);
    expect(run.signal).toBe(job.controller.signal);
    expect(run.signal.aborted).toBe(false);
    registry.cancel(job.id);
    // The same signal object the scheduler parked against, so the park's abort
    // listener fires. A copy, or a signal taken from a different job, would
    // leave the run waiting exactly as it did before.
    expect(run.signal.aborted).toBe(true);
  });

  it("marks the pause as PARKED, so the row survives a dismiss", () => {
    // A parked run is a live closure that resumes into this same row.
    // Dismissing it would delete the only sign the work still exists.
    const job = registry.create("pipeline", { label: "Scanning your photos" });
    runFor(job).onPause("Finding faces");
    const row = registry.list().find((j) => j.id === job.id);
    expect(row.status).toBe("paused");
    expect(row.parked).toBe(true);
    expect(row.pauseReason).toContain("Finding faces");
    expect(registry.dismiss(job.id)).toBe(false);
  });

  it("resumes back to running and clears the parked flag", () => {
    const job = registry.create("pipeline", { label: "Scanning your photos" });
    const run = runFor(job);
    run.onPause("Finding faces");
    run.onResume();
    const row = registry.list().find((j) => j.id === job.id);
    expect(row.status).toBe("running");
    expect(row.parked).toBe(false);
    expect(row.pauseReason).toBe("");
  });

  it("passes the job's label through, so a run can name what blocks others", () => {
    const job = registry.create("faces", {
      label: "Finding faces in 20 photos",
    });
    expect(runFor(job).label).toBe("Finding faces in 20 photos");
  });
});

describe("waitingFor — a park names its blocker (#282)", () => {
  it("names the run ahead when it has a label", () => {
    expect(waitingFor("Finding faces")).toContain("Finding faces");
    expect(waitingFor("Finding faces")).toMatch(/resumes on its own/);
  });

  it("says 'another request' rather than inventing a name", () => {
    expect(waitingFor(null)).toMatch(/another request/);
    expect(waitingFor(null)).not.toMatch(/undefined|null/);
  });
});
