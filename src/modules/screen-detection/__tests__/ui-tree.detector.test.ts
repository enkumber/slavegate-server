/**
 * screen-detection/__tests__/ui-tree.detector.test.ts
 * Unit tests for UiTreeDetector.
 * Run: npx vitest run src/modules/screen-detection/__tests__/ui-tree.detector.test.ts
 * Story: US-SCREEN-CASCADE
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UiTreeDetector } from '../detectors/ui-tree.detector';
import type { UiNode, ScreenRule } from '../types';

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<ScreenRule>): ScreenRule {
  return {
    id: 'HOME_FEED',
    priority: 100,
    critical: false,
    overlay: false,
    uiTreeMarkers: { required: [], anyOf: [], exclude: [] },
    navBar: { visible: true, selectedTab: null },
    ...overrides,
  };
}

function makeNode(overrides: Partial<UiNode>): UiNode {
  return {
    resourceId: undefined,
    text: undefined,
    contentDescription: undefined,
    className: undefined,
    children: [],
    ...overrides,
  };
}

// ─── Instagram-like UI tree fixtures ─────────────────────────────────────────

const HOME_FEED_NODES: UiNode[] = [
  makeNode({ resourceId: 'com.instagram.android:id/feed_tab',          contentDescription: 'Home' }),
  makeNode({ resourceId: 'com.instagram.android:id/action_bar_title',  text: 'Instagram' }),
  makeNode({ resourceId: 'com.instagram.android:id/row_feed_photo' }),
  makeNode({ resourceId: 'com.instagram.android:id/nav_bar' }),
];

const REELS_NODES: UiNode[] = [
  makeNode({ resourceId: 'com.instagram.android:id/clips_viewer', contentDescription: 'reel by user' }),
  makeNode({ resourceId: 'com.instagram.android:id/clips_tab' }),
  makeNode({ text: 'Audio · original sound' }),
];

const ACTION_BLOCKED_NODES: UiNode[] = [
  makeNode({ text: 'Action Blocked', className: 'android.widget.TextView' }),
  makeNode({ text: 'We restrict certain activity to protect our community.' }),
  makeNode({ text: 'Tell us if you think we made a mistake.' }),
];

const PROFILE_OWN_NODES: UiNode[] = [
  makeNode({ resourceId: 'com.instagram.android:id/profile_tab', contentDescription: 'Profile' }),
  makeNode({ text: 'Edit profile', className: 'android.widget.Button' }),
  makeNode({ resourceId: 'com.instagram.android:id/profile_header' }),
];

const KEYBOARD_NODES: UiNode[] = [
  makeNode({ className: 'android.inputmethodservice.InputMethodService' }),
  makeNode({ text: 'q' }),
  makeNode({ text: 'w' }),
];

// ─── Rules ────────────────────────────────────────────────────────────────────

const HOME_FEED_RULE = makeRule({
  id: 'HOME_FEED',
  priority: 100,
  uiTreeMarkers: {
    required: [{ resourceId: 'com.instagram.android:id/feed_tab' }],
    anyOf: [
      { resourceId: 'com.instagram.android:id/action_bar_title' },
      { resourceId: 'com.instagram.android:id/row_feed_photo' },
    ],
    exclude: [{ resourceId: 'com.instagram.android:id/clips_viewer' }],
  },
  navBar: { visible: true, selectedTab: 'home' },
});

const ACTION_BLOCKED_RULE = makeRule({
  id: 'ACTION_BLOCKED',
  priority: 250,
  critical: true,
  uiTreeMarkers: {
    anyOf: [
      { text_contains: 'Action Blocked' },
      { text_contains: 'Try Again Later' },
      { text_contains: 'We restrict certain activity' },
    ],
  },
  navBar: { visible: false },
});

const REELS_RULE = makeRule({
  id: 'REELS_FULLSCREEN',
  priority: 95,
  uiTreeMarkers: {
    anyOf: [
      { resourceId: 'com.instagram.android:id/clips_viewer' },
      { contentDescription_contains: 'reel' },
    ],
    exclude: [{ resourceId: 'com.instagram.android:id/feed_tab' }],
  },
  navBar: { visible: false },
});

const KEYBOARD_RULE = makeRule({
  id: 'KEYBOARD_OPEN',
  priority: 200,
  overlay: true,
  uiTreeMarkers: {
    anyOf: [{ className: 'android.inputmethodservice.InputMethodService' }],
  },
  navBar: { visible: false },
});

const PROFILE_OWN_RULE = makeRule({
  id: 'PROFILE_OWN',
  priority: 75,
  uiTreeMarkers: {
    required: [{ resourceId: 'com.instagram.android:id/profile_tab' }],
    anyOf: [
      { text: 'Edit profile' },
      { text: 'Editează profilul' },
    ],
  },
  navBar: { visible: true, selectedTab: 'profile' },
});

const ALL_RULES = [HOME_FEED_RULE, ACTION_BLOCKED_RULE, REELS_RULE, KEYBOARD_RULE, PROFILE_OWN_RULE];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UiTreeDetector', () => {
  let detector: UiTreeDetector;

  beforeEach(() => {
    detector = new UiTreeDetector();
  });

  describe('detect() — HOME_FEED', () => {
    it('should detect HOME_FEED with high confidence', () => {
      const result = detector.detect(HOME_FEED_NODES, ALL_RULES);
      expect(result.screenId).toBe('HOME_FEED');
      expect(result.confidence).toBeGreaterThanOrEqual(0.90);
    });

    it('should match required + anyOf → confidence 0.95', () => {
      const result = detector.detect(HOME_FEED_NODES, ALL_RULES);
      expect(result.confidence).toBe(0.95);
    });

    it('should include matched markers in result', () => {
      const result = detector.detect(HOME_FEED_NODES, ALL_RULES);
      expect(result.markers.length).toBeGreaterThan(0);
    });

    it('should set navBar.selectedTab to home', () => {
      const result = detector.detect(HOME_FEED_NODES, ALL_RULES);
      expect(result.navBar.selectedTab).toBe('home');
      expect(result.navBar.visible).toBe(true);
    });
  });

  describe('detect() — ACTION_BLOCKED (critical)', () => {
    it('should detect ACTION_BLOCKED as critical screen', () => {
      const result = detector.detect(ACTION_BLOCKED_NODES, ALL_RULES);
      expect(result.screenId).toBe('ACTION_BLOCKED');
    });

    it('should detect ACTION_BLOCKED via text_contains', () => {
      const nodes = [makeNode({ text: 'Action Blocked' })];
      const result = detector.detect(nodes, [ACTION_BLOCKED_RULE]);
      expect(result.screenId).toBe('ACTION_BLOCKED');
    });

    it('should detect ACTION_BLOCKED via "We restrict certain activity"', () => {
      const nodes = [makeNode({ text: 'We restrict certain activity to protect our community.' })];
      const result = detector.detect(nodes, [ACTION_BLOCKED_RULE]);
      expect(result.screenId).toBe('ACTION_BLOCKED');
    });
  });

  describe('detect() — REELS_FULLSCREEN', () => {
    it('should detect REELS via clips_viewer resourceId', () => {
      const result = detector.detect(REELS_NODES, ALL_RULES);
      expect(result.screenId).toBe('REELS_FULLSCREEN');
    });

    it('should detect REELS via contentDescription_contains "reel"', () => {
      const nodes = [makeNode({ contentDescription: 'reel by some_user' })];
      const result = detector.detect(nodes, [REELS_RULE]);
      expect(result.screenId).toBe('REELS_FULLSCREEN');
    });

    it('should NOT detect REELS if feed_tab is present (exclude rule)', () => {
      const nodes = [
        makeNode({ resourceId: 'com.instagram.android:id/clips_viewer' }),
        makeNode({ resourceId: 'com.instagram.android:id/feed_tab' }), // excluded
      ];
      const result = detector.detect(nodes, [REELS_RULE]);
      expect(result.screenId).toBe('UNKNOWN');
    });
  });

  describe('detect() — KEYBOARD overlay', () => {
    it('should detect KEYBOARD_OPEN as overlay', () => {
      const result = detector.detect(KEYBOARD_NODES, ALL_RULES);
      expect(result.overlays).toContain('KEYBOARD_OPEN');
    });

    it('keyboard overlay should not replace main screen detection', () => {
      const nodes = [...HOME_FEED_NODES, ...KEYBOARD_NODES];
      const result = detector.detect(nodes, ALL_RULES);
      expect(result.screenId).toBe('HOME_FEED');
      expect(result.overlays).toContain('KEYBOARD_OPEN');
    });
  });

  describe('detect() — PROFILE_OWN', () => {
    it('should detect PROFILE_OWN via required + anyOf', () => {
      const result = detector.detect(PROFILE_OWN_NODES, ALL_RULES);
      expect(result.screenId).toBe('PROFILE_OWN');
    });
  });

  describe('detect() — UNKNOWN', () => {
    it('should return UNKNOWN for empty tree', () => {
      const result = detector.detect([], ALL_RULES);
      expect(result.screenId).toBe('UNKNOWN');
      expect(result.confidence).toBe(0);
    });

    it('should return UNKNOWN for unrecognized screen', () => {
      const nodes = [makeNode({ text: 'Some random screen' })];
      const result = detector.detect(nodes, ALL_RULES);
      expect(result.screenId).toBe('UNKNOWN');
    });
  });

  describe('detect() — rawData', () => {
    it('should include uiTreeNodeCount in rawData', () => {
      const result = detector.detect(HOME_FEED_NODES, ALL_RULES);
      expect(result.rawData?.uiTreeNodeCount).toBe(HOME_FEED_NODES.length);
    });
  });

  describe('marker matching edge cases', () => {
    it('should match text case-insensitively via regex', () => {
      const nodes = [makeNode({ text: 'EDIT PROFILE' })];
      // text match with string is case-insensitive (uses /i flag)
      const result = detector.detect(nodes, [
        makeRule({
          id: 'PROFILE_OWN',
          uiTreeMarkers: { anyOf: [{ text: 'Edit profile' }] },
        }),
      ]);
      expect(result.screenId).toBe('PROFILE_OWN');
    });

    it('should match resourceId_contains', () => {
      const nodes = [makeNode({ resourceId: 'com.foo.android:id/keyboard_input' })];
      const result = detector.detect(nodes, [
        makeRule({
          id: 'KEYBOARD_OPEN',
          overlay: true,
          uiTreeMarkers: { anyOf: [{ resourceId_contains: 'keyboard' }] },
        }),
      ]);
      expect(result.overlays).toContain('KEYBOARD_OPEN');
    });

    it('should match text_starts_with', () => {
      const nodes = [makeNode({ text: '#photography' })];
      const result = detector.detect(nodes, [
        makeRule({
          id: 'HASHTAG_FEED',
          uiTreeMarkers: { anyOf: [{ text_starts_with: '#' }] },
        }),
      ]);
      expect(result.screenId).toBe('HASHTAG_FEED');
    });

    it('should match nested nodes (tree flattening)', () => {
      const nestedNodes: UiNode[] = [
        {
          resourceId: 'root',
          children: [
            {
              resourceId: 'child',
              children: [
                makeNode({ resourceId: 'com.instagram.android:id/feed_tab' }),
                makeNode({ resourceId: 'com.instagram.android:id/row_feed_photo' }),
              ],
            },
          ],
        },
      ];
      const result = detector.detect(nestedNodes, [HOME_FEED_RULE]);
      expect(result.screenId).toBe('HOME_FEED');
    });

    it('should match contentDescription exactly', () => {
      const nodes = [makeNode({ contentDescription: 'Home' })];
      const result = detector.detect(nodes, [
        makeRule({
          id: 'HOME_FEED',
          uiTreeMarkers: { anyOf: [{ contentDescription: 'Home' }] },
        }),
      ]);
      expect(result.screenId).toBe('HOME_FEED');
    });
  });

  describe('flattenTree', () => {
    it('should flatten nested tree', () => {
      const tree: UiNode[] = [
        { children: [{ children: [{ text: 'deep' }] }] },
        { text: 'top' },
      ];
      const flat = detector.flattenTree(tree);
      expect(flat.length).toBe(4);
      expect(flat.some(n => n.text === 'deep')).toBe(true);
    });
  });
});
