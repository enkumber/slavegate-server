/**
 * workflow.executor.batch.test.ts
 *
 * Unit tests for:
 *   1. compileBatchSegments() — grouping consecutive steps into batchable segments
 *   2. workflowStepToBatchStep() — conversion from WorkflowStep to BatchStep
 *   3. Batch checkpoint recovery logic
 */

import { describe, it, expect } from "vitest";
import {
  compileBatchSegments,
  type BatchSegment,
} from "./workflow.executor";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAction(id: number, action: string, params?: Record<string, unknown>, x?: number, y?: number): any {
  return {
    id,
    type: "action",
    action,
    params: params ?? {},
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
  };
}

function makeWait(id: number, durationMs = 100): any {
  return { id, type: "wait", params: { durationMs } };
}

function makeCondition(id: number): any {
  return { id, type: "condition", params: {} };
}

function makeLoop(id: number, steps: any[] = []): any {
  return { id, type: "loop", params: { count: 2 }, steps };
}

// ─── compileBatchSegments tests ───────────────────────────────────────────────

describe("compileBatchSegments", () => {

  it("empty steps → no segments", () => {
    const segs = compileBatchSegments([]);
    expect(segs).toHaveLength(0);
  });

  it("single action → single non-batched segment", () => {
    const steps = [makeAction(1, "tap")];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBatched).toBe(false);
    expect(segs[0].steps).toHaveLength(1);
  });

  it("two consecutive tap actions → one batched segment", () => {
    const steps = [makeAction(1, "tap"), makeAction(2, "tap")];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(2);
  });

  it("three consecutive action steps → one batched segment", () => {
    const steps = [
      makeAction(1, "tap"),
      makeAction(2, "type", { text: "hello" }),
      makeAction(3, "press_back"),
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(3);
  });

  it("action + condition → separate segments", () => {
    const steps = [makeAction(1, "tap"), makeCondition(2), makeAction(3, "tap")];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(3);
    expect(segs[0].isBatched).toBe(false); // singleton tap → not worth a batch
    expect(segs[1].isBatched).toBe(false);
    expect(segs[2].isBatched).toBe(false);
  });

  it("condition separates batch runs", () => {
    const steps = [
      makeAction(1, "tap"),
      makeAction(2, "tap"),
      makeCondition(3),
      makeAction(4, "tap"),
      makeAction(5, "tap"),
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(3);
    // First [tap, tap] → batched
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(2);
    // condition → separate
    expect(segs[1].isBatched).toBe(false);
    // Second [tap, tap] → batched
    expect(segs[2].isBatched).toBe(true);
    expect(segs[2].steps).toHaveLength(2);
  });

  it("loop separates batch runs", () => {
    const steps = [
      makeAction(1, "tap"),
      makeAction(2, "tap"),
      makeLoop(3, []),
      makeAction(4, "tap"),
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(3);
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(2);
    expect(segs[1].isBatched).toBe(false);
    expect(segs[2].isBatched).toBe(false); // single tap after loop → not batched
  });

  it("wait step separates batch runs", () => {
    const steps = [
      makeAction(1, "tap"),
      makeAction(2, "tap"),
      makeWait(3),
      makeAction(4, "tap"),
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(3);
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(2);
    expect(segs[1].isBatched).toBe(false); // wait
    expect(segs[2].isBatched).toBe(false); // singleton tap after wait
  });

  it("cascade tap (target without coords) → NOT batched", () => {
    const steps = [
      { id: "1", type: "action" as const, action: "tap", params: {}, target: "post.like" },
      { id: "2", type: "action" as const, action: "tap", params: {}, target: "post.share" },
    ];
    const segs = compileBatchSegments(steps);
    // Both are cascade taps (target present at root, no coords) → neither is batchable
    // → singleton non-batched segments
    expect(segs).toHaveLength(2);
    expect(segs[0].isBatched).toBe(false);
    expect(segs[1].isBatched).toBe(false);
  });

  it("explicit coords tap → batchable", () => {
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.3),
      makeAction(2, "tap", {}, 0.6, 0.4),
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBatched).toBe(true);
  });

  it("action with retries → NOT batched (retry logic complicates batch state)", () => {
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.3),
      { ...makeAction(2, "tap", {}, 0.6, 0.4), retries: 2 },
    ];
    const segs = compileBatchSegments(steps);
    // Second step has retries → not batchable, so singleton segments
    expect(segs).toHaveLength(2);
    expect(segs[0].isBatched).toBe(false);
    expect(segs[1].isBatched).toBe(false);
  });

  it("textFromVariable → NOT batched", () => {
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.3),
      makeAction(2, "type", { textFromVariable: "username" }),
    ];
    const segs = compileBatchSegments(steps);
    // textFromVariable requires server-side resolution → second step NOT batchable
    expect(segs).toHaveLength(2);
    expect(segs[0].isBatched).toBe(false); // singleton
    expect(segs[1].isBatched).toBe(false);
  });

  it("expectedScreen verification → NOT batched", () => {
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.3),
      { ...makeAction(2, "tap", {}, 0.6, 0.4), expectedScreen: "home" },
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(2);
    expect(segs[0].isBatched).toBe(false);
    expect(segs[1].isBatched).toBe(false);
  });

  it("mixed action types all batchable → one batch", () => {
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.5),
      makeAction(2, "type", { text: "hello" }),
      makeAction(3, "swipe", { direction: "up" }),
      makeAction(4, "press_back"),
      makeAction(5, "open_app", { packageName: "com.instagram.android" }),
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(5);
  });

  it("batchable actions + skip non-batchable → mixed segments", () => {
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.5),
      makeAction(2, "tap", {}, 0.6, 0.6),
      makeCondition(3),
      makeAction(4, "tap", {}, 0.7, 0.7),
      makeAction(5, "tap", {}, 0.8, 0.8),
      makeWait(6),
      makeAction(7, "type", { text: "test" }),
    ];
    const segs = compileBatchSegments(steps);
    // [tap, tap] → batched; condition → separate; [tap, tap] → batched; wait → separate; type → singleton
    expect(segs).toHaveLength(5);
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(2);
    expect(segs[1].isBatched).toBe(false);
    expect(segs[2].isBatched).toBe(true);
    expect(segs[2].steps).toHaveLength(2);
    expect(segs[3].isBatched).toBe(false);
    expect(segs[4].isBatched).toBe(false); // singleton type after wait
  });

  it("startIndex offsets segment startIndex correctly", () => {
    // Simulate steps starting at index 5 in the full workflow
    // Must have enough steps for slice(startIndex) to produce content
    const steps = [
      makeWait(0, 100),                // 0: skip
      makeWait(1, 100),                // 1: skip
      makeWait(2, 100),                // 2: skip
      makeWait(3, 100),                // 3: skip
      makeWait(4, 100),                // 4: skip
      makeAction(5, "tap", {}, 0.5, 0.5), // 5: included
      makeAction(6, "tap", {}, 0.6, 0.6), // 6: included
    ];
    const segs = compileBatchSegments(steps, 5);
    // Steps 0-4 are sliced away. Steps 5-6 are consecutive batchable → 1 batch
    expect(segs).toHaveLength(1);
    expect(segs[0].startIndex).toBe(5);
  });

  it("all non-batchable types → all singleton segments", () => {
    const steps = [
      makeCondition(1),
      makeLoop(2, []),
      makeWait(3),
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(3);
    segs.forEach(s => expect(s.isBatched).toBe(false));
  });

  it("large batch of 50 consecutive actions → one segment", () => {
    const steps = Array.from({ length: 50 }, (_, i) =>
      makeAction(i + 1, "tap", {}, 0.5, 0.5)
    );
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(50);
  });

  it("alternating batchable/non-batchable → many segments", () => {
    // Every other step is a condition → lots of tiny segments
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.5),
      makeCondition(2),
      makeAction(3, "tap", {}, 0.6, 0.6),
      makeCondition(4),
      makeAction(5, "tap", {}, 0.7, 0.7),
    ];
    const segs = compileBatchSegments(steps);
    // Each tap is a singleton (1 consecutive) → not batched
    expect(segs).toHaveLength(5);
    segs.forEach(s => expect(s.isBatched).toBe(false));
  });

  // ─── CRITICAL REGRESSION TEST ──────────────────────────────────────────────
  // Bug: compileBatchSegments had an infinite loop when a step was an action
  // that was neither a skill action nor batchable (e.g., screen_wake, unlock).
  // This caused complete server freeze — event loop blocked by synchronous while loop.
  it("non-batchable, non-skill action (screen_wake, unlock) → singleton, no infinite loop", () => {
    // These actions are in neither BATCHABLE_ACTIONS nor skill actions
    const steps = [
      makeAction(1, "set_variable"),  // skill action → singleton
      makeAction(2, "screen_wake"),   // NOT batchable, NOT skill → was infinite loop!
      makeAction(3, "unlock"),        // NOT batchable, NOT skill → was infinite loop!
      makeAction(4, "tap", {}, 0.5, 0.5), // batchable
      makeAction(5, "screenshot"),    // NOT batchable, NOT skill → was infinite loop!
    ];

    // This call must complete (not hang) — that's the real test
    const segs = compileBatchSegments(steps);

    expect(segs).toHaveLength(5);
    expect(segs[0].isBatched).toBe(false); // set_variable → singleton
    expect(segs[0].steps).toHaveLength(1);
    expect(segs[1].isBatched).toBe(false); // screen_wake → singleton
    expect(segs[1].steps).toHaveLength(1);
    expect(segs[2].isBatched).toBe(false); // unlock → singleton
    expect(segs[2].steps).toHaveLength(1);
    expect(segs[3].isBatched).toBe(false); // tap (single) → singleton
    expect(segs[3].steps).toHaveLength(1);
    expect(segs[4].isBatched).toBe(false); // screenshot → singleton
    expect(segs[4].steps).toHaveLength(1);
  });

  it("non-batchable action followed by batchable run → correct segmentation", () => {
    const steps = [
      makeAction(1, "screen_wake"),   // non-batchable
      makeAction(2, "tap", {}, 0.5, 0.5), // batchable
      makeAction(3, "tap", {}, 0.6, 0.6), // batchable
      makeAction(4, "unlock"),        // non-batchable
    ];
    const segs = compileBatchSegments(steps);
    expect(segs).toHaveLength(3);
    expect(segs[0].isBatched).toBe(false); // screen_wake singleton
    expect(segs[1].isBatched).toBe(true);  // [tap, tap] batch
    expect(segs[1].steps).toHaveLength(2);
    expect(segs[2].isBatched).toBe(false); // unlock singleton
  });
});

// ─── Integration: batch segmentation for realistic workflows ─────────────────

describe("compileBatchSegments — realistic workflows", () => {

  it("instagram-like workflow: navigation → action cascade → back", () => {
    // Typical pattern: open app, wait, tap several things, go back
    const steps = [
      makeAction(1, "open_app", { packageName: "com.instagram.android" }),
      makeWait(2, 2000),            // wait for app to load
      makeAction(3, "tap", {}, 0.5, 0.3), // tap search icon
      makeAction(4, "type", { text: "cat" }), // type search
      makeAction(5, "tap", {}, 0.5, 0.5), // tap first result
      makeAction(6, "tap", {}, 0.5, 0.8), // tap follow button
      makeAction(7, "press_back"),         // go back
    ];

    const segs = compileBatchSegments(steps);

    // open_app → singleton (only 1 consecutive batchable before wait)
    // wait → singleton (non-action)
    // [tap, type, tap, tap, press_back] → batched (5 consecutive batchable)
    expect(segs).toHaveLength(3);
    expect(segs[0].isBatched).toBe(false);
    expect(segs[0].steps).toHaveLength(1); // open_app
    expect(segs[1].isBatched).toBe(false); // wait
    expect(segs[2].isBatched).toBe(true);
    expect(segs[2].steps).toHaveLength(5); // tap + type + tap + tap + press_back
  });

  it("loop with batchable body → separate segment for loop", () => {
    const steps = [
      makeAction(1, "tap", {}, 0.5, 0.5),
      makeAction(2, "tap", {}, 0.5, 0.6),
      makeLoop(3, [
        makeAction(100, "tap", {}, 0.5, 0.7),
        makeAction(101, "tap", {}, 0.5, 0.8),
      ]),
      makeAction(4, "press_back"),
    ];

    const segs = compileBatchSegments(steps);

    // [tap, tap] before loop → batched
    expect(segs[0].isBatched).toBe(true);
    expect(segs[0].steps).toHaveLength(2);
    // loop → separate segment (not batched)
    expect(segs[1].isBatched).toBe(false);
    expect(segs[1].steps[0].type).toBe("loop");
    // press_back → singleton
    expect(segs[2].isBatched).toBe(false);
  });
});
