/**
 * screen-detection/__tests__/rule-engine.test.ts
 * Unit tests for parseDetectionRules() and parseUiMarker().
 * Run: npx vitest run src/modules/screen-detection/__tests__/rule-engine.test.ts
 * Story: US-SCREEN-CASCADE
 */

import { describe, it, expect } from 'vitest';
import { parseDetectionRules, parseUiMarker, markerToString } from '../rules/rule-engine';

// ─── Sample skill YAML ────────────────────────────────────────────────────────

const SAMPLE_SKILL_YAML = `
platform: test_platform

detection_rules:

  ACTION_BLOCKED:
    priority: 250
    critical: true
    ui_tree:
      anyOf:
        - text_contains: "Action Blocked"
        - text_contains: "Try Again Later"
    ocr:
      anyOf:
        - "Action Blocked"
        - "Try Again Later"
    nav_bar:
      visible: false

  HOME_FEED:
    priority: 100
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/feed_tab"
      anyOf:
        - resourceId: "com.instagram.android:id/row_feed_photo"
      exclude:
        - resourceId: "com.instagram.android:id/clips_viewer"
    ocr:
      anyOf:
        - "Instagram"
      exclude:
        - "Watch again"
    nav_bar:
      visible: true
      selected_tab: home

  REELS_FULLSCREEN:
    priority: 95
    ui_tree:
      anyOf:
        - resourceId: "com.instagram.android:id/clips_viewer"
    nav_bar:
      visible: false
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseDetectionRules', () => {
  it('should return empty array for skill without detection_rules', () => {
    const rules = parseDetectionRules('platform: test\n');
    expect(rules).toEqual([]);
  });

  it('should parse 3 rules from sample YAML', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    expect(rules).toHaveLength(3);
  });

  it('should sort rules by priority descending', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    expect(rules[0].id).toBe('ACTION_BLOCKED');   // priority 250
    expect(rules[1].id).toBe('HOME_FEED');         // priority 100
    expect(rules[2].id).toBe('REELS_FULLSCREEN');  // priority 95
  });

  it('should parse critical flag correctly', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    const blocked = rules.find(r => r.id === 'ACTION_BLOCKED');
    expect(blocked?.critical).toBe(true);

    const feed = rules.find(r => r.id === 'HOME_FEED');
    expect(feed?.critical).toBe(false);
  });

  it('should parse uiTreeMarkers.required correctly', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    const feed = rules.find(r => r.id === 'HOME_FEED');
    expect(feed?.uiTreeMarkers.required).toHaveLength(1);
    expect(feed?.uiTreeMarkers.required![0]).toMatchObject({
      resourceId: 'com.instagram.android:id/feed_tab',
    });
  });

  it('should parse uiTreeMarkers.anyOf correctly', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    const blocked = rules.find(r => r.id === 'ACTION_BLOCKED');
    expect(blocked?.uiTreeMarkers.anyOf).toHaveLength(2);
    expect(blocked?.uiTreeMarkers.anyOf![0]).toMatchObject({ text_contains: 'Action Blocked' });
  });

  it('should parse uiTreeMarkers.exclude correctly', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    const feed = rules.find(r => r.id === 'HOME_FEED');
    expect(feed?.uiTreeMarkers.exclude).toHaveLength(1);
    expect(feed?.uiTreeMarkers.exclude![0]).toMatchObject({
      resourceId: 'com.instagram.android:id/clips_viewer',
    });
  });

  it('should parse ocrMarkers correctly', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    const feed = rules.find(r => r.id === 'HOME_FEED');
    expect(feed?.ocrMarkers?.anyOf).toContain('Instagram');
    expect(feed?.ocrMarkers?.exclude).toContain('Watch again');
  });

  it('should parse navBar correctly', () => {
    const rules = parseDetectionRules(SAMPLE_SKILL_YAML);
    const feed = rules.find(r => r.id === 'HOME_FEED');
    expect(feed?.navBar.visible).toBe(true);
    expect(feed?.navBar.selectedTab).toBe('home');

    const blocked = rules.find(r => r.id === 'ACTION_BLOCKED');
    expect(blocked?.navBar.visible).toBe(false);
    expect(blocked?.navBar.selectedTab).toBeNull();
  });

  it('should handle invalid YAML gracefully', () => {
    expect(() => parseDetectionRules('{ bad yaml: [')).toThrow();
  });
});

describe('parseUiMarker', () => {
  it('should parse resourceId from string with :id/', () => {
    const marker = parseUiMarker('com.instagram.android:id/feed_tab');
    expect(marker).toMatchObject({ resourceId: 'com.instagram.android:id/feed_tab' });
  });

  it('should parse text from plain string without :id/', () => {
    const marker = parseUiMarker('Action Blocked');
    expect(marker).toMatchObject({ text: 'Action Blocked' });
  });

  it('should pass through object markers unchanged', () => {
    const obj = { text_contains: 'Action Blocked', className: 'android.app.Dialog' };
    const marker = parseUiMarker(obj);
    expect(marker).toMatchObject(obj);
  });

  it('should return null for null/undefined input', () => {
    expect(parseUiMarker(null)).toBeNull();
    expect(parseUiMarker(undefined)).toBeNull();
  });
});

describe('markerToString', () => {
  it('should serialize resourceId', () => {
    const s = markerToString({ resourceId: 'com.foo:id/bar' });
    expect(s).toContain('resourceId=com.foo:id/bar');
  });

  it('should serialize multiple fields', () => {
    const s = markerToString({ text_contains: 'hello', className: 'android.widget.Button' });
    expect(s).toContain('text_contains=hello');
    expect(s).toContain('className=android.widget.Button');
  });
});
