/**
 * __tests__/reddit-screen-detection.test.ts
 * Unit tests for Reddit screen detection rules.
 * Tests L1 (UI Tree) and L2 (OCR) detection for all Reddit screens.
 * Run: npx vitest run src/modules/screen-detection/__tests__/reddit-screen-detection.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { parseDetectionRules } from '../rules/rule-engine';
import { UiTreeDetector } from '../detectors/ui-tree.detector';
import { OcrDetector } from '../detectors/ocr.detector';
import type { UiNode, OcrResult, ScreenRule } from '../types';
import * as fs from 'fs';
import * as path from 'path';

// Load Reddit skill file
const redditSkillPath = path.resolve(__dirname, '../../skills/templates/reddit.skill');
const redditSkillContent = fs.readFileSync(redditSkillPath, 'utf-8');

let rules: ScreenRule[];
let uiDetector: UiTreeDetector;
let ocrDetector: OcrDetector;

beforeAll(() => {
  rules = parseDetectionRules(redditSkillContent);
  uiDetector = new UiTreeDetector();
  ocrDetector = new OcrDetector();
});

describe('Reddit Screen Detection Rules', () => {
  it('should parse all Reddit rules', () => {
    expect(rules.length).toBeGreaterThanOrEqual(14);
    
    const ruleIds = rules.map(r => r.id);
    expect(ruleIds).toContain('REDDIT_HOME_FEED');
    expect(ruleIds).toContain('REDDIT_POST_DETAIL');
    expect(ruleIds).toContain('REDDIT_SUBREDDIT');
    expect(ruleIds).toContain('REDDIT_RATE_LIMITED');
    expect(ruleIds).toContain('REDDIT_LOGIN');
  });

  it('critical rules have priority 250', () => {
    const criticalRules = rules.filter(r => r.critical);
    criticalRules.forEach(rule => {
      expect(rule.priority).toBe(250);
    });
  });
});

describe('L1: UI Tree Detection', () => {
  it('detects HOME_FEED', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        resourceId: 'com.reddit.frontpage:id/frame_container',
        children: [{
          resourceId: 'home_screen_surface',
          children: [{
            resourceId: 'feed_lazy_column',
            children: [{ resourceId: 'post_unit' }]
          }]
        }]
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('REDDIT_HOME_FEED');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects POST_DETAIL', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        resourceId: 'post_detail_scaffold',
        children: [{
          resourceId: 'comments_list',
          children: [{ text: 'Nice post!' }]
        }]
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('REDDIT_POST_DETAIL');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects SUBREDDIT', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        resourceId: 'subreddit_header',
        children: [{
          text: 'r/AskReddit',
          children: [{ text: 'Join' }]
        }]
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('REDDIT_SUBREDDIT');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects SEARCH', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        resourceId: 'search_results_container',
        children: [{
          resourceId: 'search_input',
          text: 'Search Reddit'
        }]
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('REDDIT_SEARCH');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects RATE_LIMITED (critical)', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        text: 'you are doing that too much',
        children: [{ text: 'try again in 5 minutes' }]
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('REDDIT_RATE_LIMITED');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects LOGIN (critical)', () => {
    const tree: UiNode[] = [{
      resourceId: 'login_container',
      children: [{
        resourceId: 'username_input',
        children: [{ text: 'Log in' }]
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('REDDIT_LOGIN');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects PROFILE_OWN', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        resourceId: 'profile_header',
        children: [{
          resourceId: 'profile_avatar_picture',
          children: [{ text: 'Edit' }]
        }]
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('REDDIT_PROFILE_OWN');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('returns UNKNOWN for unrecognized screen', () => {
    const tree: UiNode[] = [{
      resourceId: 'some_random_id',
      text: 'random text'
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.screenId).toBe('UNKNOWN');
    expect(result.confidence).toBe(0);
  });
});

describe('L2: OCR Detection', () => {
  it('detects RATE_LIMITED via OCR', () => {
    const ocr: OcrResult = {
      blocks: [
        { text: 'you are doing that too much', bounds: {x:0,y:0,width:100,height:20}, confidence: 0.95 },
        { text: 'try again in 5 minutes', bounds: {x:0,y:20,width:100,height:20}, confidence: 0.95 }
      ],
      fullText: 'you are doing that too much try again in 5 minutes'
    };

    const result = ocrDetector.detect(ocr, rules);
    expect(result.screenId).toBe('REDDIT_RATE_LIMITED');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects SUBREDDIT via OCR', () => {
    const ocr: OcrResult = {
      blocks: [
        { text: 'r/AskReddit', bounds: {x:0,y:0,width:100,height:20}, confidence: 0.95 },
        { text: 'Join', bounds: {x:0,y:20,width:50,height:20}, confidence: 0.95 }
      ],
      fullText: 'r/AskReddit Join Hot New Top'
    };

    const result = ocrDetector.detect(ocr, rules);
    expect(result.screenId).toBe('REDDIT_SUBREDDIT');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects HOME_FEED via OCR', () => {
    const ocr: OcrResult = {
      blocks: [
        { text: 'For you', bounds: {x:0,y:0,width:100,height:20}, confidence: 0.95 },
        { text: 'Popular', bounds: {x:0,y:20,width:100,height:20}, confidence: 0.95 }
      ],
      fullText: 'For you Popular Following'
    };

    const result = ocrDetector.detect(ocr, rules);
    expect(result.screenId).toBe('REDDIT_HOME_FEED');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects POST_DETAIL via OCR', () => {
    const ocr: OcrResult = {
      blocks: [
        { text: 'Add a comment', bounds: {x:0,y:0,width:100,height:20}, confidence: 0.95 },
        { text: 'Reply', bounds: {x:0,y:20,width:50,height:20}, confidence: 0.95 }
      ],
      fullText: 'Add a comment Reply Share'
    };

    const result = ocrDetector.detect(ocr, rules);
    expect(result.screenId).toBe('REDDIT_POST_DETAIL');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects SEARCH via OCR', () => {
    const ocr: OcrResult = {
      blocks: [
        { text: 'Search Reddit', bounds: {x:0,y:0,width:100,height:20}, confidence: 0.95 },
        { text: 'Trending today', bounds: {x:0,y:20,width:100,height:20}, confidence: 0.95 }
      ],
      fullText: 'Search Reddit Trending today'
    };

    const result = ocrDetector.detect(ocr, rules);
    expect(result.screenId).toBe('REDDIT_SEARCH');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects COMMENT_COMPOSE via OCR', () => {
    const ocr: OcrResult = {
      blocks: [
        { text: 'Add comment', bounds: {x:0,y:0,width:100,height:20}, confidence: 0.95 }
      ],
      fullText: 'Add comment Your comment'
    };

    const result = ocrDetector.detect(ocr, rules);
    expect(result.screenId).toBe('REDDIT_COMMENT_COMPOSE');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('excludes HOME_FEED when subreddit text present', () => {
    const ocr: OcrResult = {
      blocks: [
        { text: 'r/AskReddit', bounds: {x:0,y:0,width:100,height:20}, confidence: 0.95 },
        { text: 'Join', bounds: {x:0,y:20,width:50,height:20}, confidence: 0.95 },
        { text: 'Hot', bounds: {x:0,y:40,width:50,height:20}, confidence: 0.95 }
      ],
      fullText: 'r/AskReddit Join Hot New Top'
    };

    const result = ocrDetector.detect(ocr, rules);
    // Should match SUBREDDIT, not HOME_FEED
    expect(result.screenId).toBe('REDDIT_SUBREDDIT');
  });
});

describe('Overlay Detection', () => {
  it('detects KEYBOARD_OPEN overlay', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        className: 'android.inputmethodservice.InputMethodService'
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.overlays).toContain('KEYBOARD_OPEN');
  });

  it('detects CONFIRMATION_DIALOG overlay', () => {
    const tree: UiNode[] = [{
      resourceId: 'com.reddit.frontpage:id/drawer_layout',
      children: [{
        text: 'Delete'
      }]
    }];

    const result = uiDetector.detect(tree, rules);
    expect(result.overlays).toContain('CONFIRMATION_DIALOG');
  });
});

describe('Screen Priority Ordering', () => {
  it('critical screens checked before normal screens', () => {
    const criticalRules = rules.filter(r => r.critical);
    const normalRules = rules.filter(r => !r.critical && !r.overlay);
    
    criticalRules.forEach(critical => {
      normalRules.forEach(normal => {
        expect(critical.priority).toBeGreaterThan(normal.priority);
      });
    });
  });

  it('overlays checked before normal screens', () => {
    const overlayRules = rules.filter(r => r.overlay);
    const normalRules = rules.filter(r => !r.critical && !r.overlay);
    
    overlayRules.forEach(overlay => {
      normalRules.forEach(normal => {
        expect(overlay.priority).toBeGreaterThan(normal.priority);
      });
    });
  });
});
