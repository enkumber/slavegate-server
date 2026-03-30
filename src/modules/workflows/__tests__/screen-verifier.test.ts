/**
 * screen-verifier.test.ts
 * Unit tests for screen verification module.
 * Story: US-WORKFLOW-SCREEN-VERIFY
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DetectedScreen } from '../../screen-detection/types';

// Mock dependencies before importing module
vi.mock('../../screen-detection/screen-detection.service', () => ({
  screenDetectionService: {
    clearCache: vi.fn(),
    detectScreen: vi.fn(),
  },
}));

vi.mock('../../../db/client', () => ({
  getDb: () => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }),
}));

import { verifyScreenAfterStep } from '../screen-verifier';
import { screenDetectionService } from '../../screen-detection/screen-detection.service';

describe('verifyScreenAfterStep', () => {
  const mockDetection = (overrides: Partial<DetectedScreen> = {}): DetectedScreen => ({
    screenId: 'HOME_FEED',
    confidence: 0.95,
    method: 'ui_tree',
    markers: ['test'],
    navBar: { visible: true, selectedTab: 'home' },
    overlays: [],
    latencyMs: 100,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('match scenarios', () => {
    it('should return match=true when detected screen matches expected', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'HOME_FEED', confidence: 0.95 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
      });

      expect(result.match).toBe(true);
      expect(result.shouldRetry).toBe(false);
      expect(result.shouldAbort).toBe(false);
    });

    it('should return match=true when detected is in expected array', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'PROFILE_OTHER', confidence: 0.88 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: ['HOME_FEED', 'PROFILE_OTHER', 'SEARCH_EXPLORE'],
      });

      expect(result.match).toBe(true);
    });
  });

  describe('mismatch scenarios', () => {
    it('should return shouldRetry=true on first mismatch with retry policy', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'SEARCH_EXPLORE', confidence: 0.90 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
        policy: { maxRetries: 2, delayMs: 500, action: 'retry_step' },
        currentRetry: 0,
      });

      expect(result.match).toBe(false);
      expect(result.shouldRetry).toBe(true);
      expect(result.shouldAbort).toBe(false);
    });

    it('should return shouldAbort=true when retries exhausted', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'SEARCH_EXPLORE', confidence: 0.90 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
        policy: { maxRetries: 2, delayMs: 500, action: 'retry_step' },
        currentRetry: 2,  // Already retried twice
      });

      expect(result.match).toBe(false);
      expect(result.shouldRetry).toBe(false);
      expect(result.shouldAbort).toBe(true);
    });

    it('should return shouldAbort=true immediately with abort policy', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'ACTION_BLOCKED', confidence: 0.99 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
        policy: { maxRetries: 2, delayMs: 500, action: 'abort' },
        currentRetry: 0,
      });

      expect(result.match).toBe(false);
      expect(result.shouldRetry).toBe(false);
      expect(result.shouldAbort).toBe(true);
    });

    it('should continue with warning when policy is continue_with_warning', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'UNKNOWN', confidence: 0.50 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
        policy: { maxRetries: 2, delayMs: 500, action: 'continue_with_warning' },
        currentRetry: 0,
      });

      expect(result.match).toBe(false);
      expect(result.shouldRetry).toBe(false);
      expect(result.shouldAbort).toBe(false);
    });
  });

  describe('confidence threshold', () => {
    it('should return match=false when confidence below threshold', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'HOME_FEED', confidence: 0.60 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
        confidenceThreshold: 0.75,  // Higher than 0.60
      });

      expect(result.match).toBe(false);
      expect(result.confidenceMet).toBe(false);
      expect(result.detected.screenId).toBe('HOME_FEED');  // Screen matches but confidence doesn't
    });

    it('should use custom confidence threshold when provided', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection({ screenId: 'HOME_FEED', confidence: 0.55 })
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
        confidenceThreshold: 0.50,  // Lower threshold
      });

      expect(result.match).toBe(true);
      expect(result.confidenceMet).toBe(true);
    });
  });

  describe('detection failures', () => {
    it('should handle detection errors gracefully', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockRejectedValue(
        new Error('Device disconnected')
      );

      const result = await verifyScreenAfterStep({
        deviceId: 'device-1',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
      });

      expect(result.match).toBe(false);
      expect(result.detected.screenId).toBe('UNKNOWN');
      expect(result.detected.error).toBe('Device disconnected');
    });
  });

  describe('cache clearing', () => {
    it('should clear cache before detection', async () => {
      vi.mocked(screenDetectionService.detectScreen).mockResolvedValue(
        mockDetection()
      );

      await verifyScreenAfterStep({
        deviceId: 'device-123',
        platform: 'instagram',
        workflowId: 'wf-1',
        stepIndex: 0,
        expectedScreen: 'HOME_FEED',
      });

      expect(screenDetectionService.clearCache).toHaveBeenCalledWith('device-123');
    });
  });
});
