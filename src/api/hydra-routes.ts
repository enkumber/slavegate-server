/**
 * api/hydra-routes.ts
 * REST endpoints for Hydra subagent — cascade tap, verify, VLM analysis.
 * 
 * CASCADE TAP UNIFIED API (v2):
 *   target: "@nav.home" → skill reference (lookup + full cascade + persistent learning)
 *   target: "diana"     → text literal (full cascade + session-only learning)
 * 
 * Backward compat: elementName/text params still work but are deprecated.
 */

import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { visionService } from "../modules/vision/vision.service";
import { cascadeTap, cascadeVerify, loadSkillFile, getElement } from "../modules/skills/skill.service";
import { detectCurrentScreen, verifyScreen, determineRecoveryAction } from "../modules/skills/screen-verify";
import { 
  parseTarget, 
  isSkillRef, 
  getSessionLearnedCoords, 
  setSessionLearnedCoords,
  type ParsedTarget 
} from "../modules/skills/target-parser";
import { isElementFixed } from "../modules/skills/fixed-elements/fixed-elements";
import type { OcrFindTapParams } from "../../shared/protocol/messages";
import { skillDbService, coordCacheService } from "../modules/skills/skill-db.service";
import { checkpointService } from "../modules/checkpoints/checkpoint.service";

import { sendJobToDevice, isDeviceOnline, waitForResult } from "../transport/transport";
import { directWsServer } from "../ws/direct-ws.server";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Find element by text in UI tree (recursive search)
// ═══════════════════════════════════════════════════════════════════════════════

interface UIElement {
  text?: string;
  desc?: string;
  bounds?: { l: number; t: number; r: number; b: number };
  children?: UIElement[];
  [key: string]: any;
}

function findElementByText(node: UIElement, searchText: string): UIElement | null {
  if (!node) return null;
  
  // Collect all matching elements, then pick the best one
  const matches: Array<{ element: UIElement; score: number }> = [];
  
  function collectMatches(n: UIElement) {
    if (!n) return;
    
    const nodeText = n.text || "";
    const nodeDesc = n.desc || "";
    const searchLower = searchText.toLowerCase();
    
    // Check for matches
    let score = 0;
    
    // Exact match in desc (highest priority - usually accessibility labels)
    if (nodeDesc.toLowerCase() === searchLower) {
      score = 100;
    }
    // Exact match in text
    else if (nodeText.toLowerCase() === searchLower) {
      score = 90;
    }
    // Contains in desc
    else if (nodeDesc.toLowerCase().includes(searchLower)) {
      score = 50;
    }
    // Contains in text
    else if (nodeText.toLowerCase().includes(searchLower)) {
      score = 40;
    }
    
    if (score > 0 && n.bounds && typeof n.bounds.l === 'number') {
      // Boost score for clickable elements
      if (n.clickable) score += 20;
      matches.push({ element: n, score });
    }
    
    // Recurse into children
    if (n.children && Array.isArray(n.children)) {
      for (const child of n.children) {
        collectMatches(child);
      }
    }
  }
  
  collectMatches(node);
  
  if (matches.length === 0) return null;
  
  // Sort by score descending, return best match
  matches.sort((a, b) => b.score - a.score);
  console.log(`[ui_tree] Found ${matches.length} matches for "${searchText}", best score=${matches[0].score}`);
  return matches[0].element;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Post-tap verification
// ═══════════════════════════════════════════════════════════════════════════════

async function performVerification(
  deviceId: string,
  verify: string,
  verifyTimeout: number
): Promise<{ verified?: boolean; verifyError?: string }> {
  // Wait for UI to update
  await new Promise(resolve => setTimeout(resolve, verifyTimeout));
  
  try {
    const verifyScreenshot = await dispatcherService.dispatch({
      deviceId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    sendJobToDevice(deviceId, {
      jobId: verifyScreenshot.jobId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    const screenshot = await waitForResult(verifyScreenshot.jobId, 30000);
    
    if (screenshot?.output?.image_base64) {
      const verifyResult = await visionService.handleVerifyRequest(
        deviceId,
        verifyScreenshot.jobId,
        screenshot.output.image_base64,
        verify
      );
      if (verifyResult.success) {
        return { verified: true };
      }
      return { verified: false, verifyError: `Screen does not match expected: "${verify}"` };
    }
    return { verified: false, verifyError: "Failed to capture verification screenshot" };
  } catch (verifyErr) {
    return { verified: false, verifyError: `Verification failed: ${(verifyErr as Error).message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Execute tap at coords
// ═══════════════════════════════════════════════════════════════════════════════

async function executeTapAtCoords(
  deviceId: string,
  coords: { x: number; y: number },
  screenWidth = 1080,
  screenHeight = 2160
): Promise<boolean> {
  const pixelX = Math.round(coords.x * screenWidth);
  const pixelY = Math.round(coords.y * screenHeight);
  
  try {
    const tapJob = await dispatcherService.dispatch({
      deviceId,
      type: "tap",
      params: { x: pixelX, y: pixelY },
      timeoutMs: 30000,
    });
    sendJobToDevice(deviceId, {
      jobId: tapJob.jobId,
      type: "tap",
      params: { x: pixelX, y: pixelY },
      timeoutMs: 30000,
    });
    console.log(`[cascade] Tap sent: (${pixelX}, ${pixelY}) jobId=${tapJob.jobId}`);
    const result = await waitForResult(tapJob.jobId, 30000);
    const success = result?.status === "completed";
    console.log(`[cascade] Tap result: ${success ? 'SUCCESS' : 'FAILED'}`);
    return success;
  } catch (err) {
    console.error(`[cascade] Tap executor error:`, (err as Error).message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASCADE TAP — 3-level cascade: coords → ui_tree → VLM
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/cascade-tap", async (req: Request, res: Response) => {
  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // UNIFIED TARGET PARSING
    // ═══════════════════════════════════════════════════════════════════════════
    let { 
      deviceId, 
      platform, 
      target,           // NEW: unified target param
      elementName,      // DEPRECATED: use target="@elementName"
      text,             // DEPRECATED: use target="textLiteral"
      near,             // Spatial anchor (future)
      relation,         // Spatial relation (future)
      verify, 
      verifyTimeout = 2000, 
      timeoutMs = 30000,
      learn,            // Override auto-learn behavior
    } = req.body;

    // Validate deviceId
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "Missing deviceId" });
    }

    // Check device connected
    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }

    // ─── BACKWARD COMPATIBILITY: Convert old params to target ─────────────────
    if (!target) {
      if (elementName) {
        target = `@${elementName}`;
        console.warn(`[cascade-tap] DEPRECATED: Use target="@${elementName}" instead of elementName`);
      } else if (text) {
        target = text;
        console.warn(`[cascade-tap] DEPRECATED: Use target="${text}" instead of text`);
      } else {
        return res.status(400).json({ 
          ok: false, 
          error: "Missing target (or deprecated elementName/text)" 
        });
      }
    }

    // Parse target into type and value
    let parsedTarget: ParsedTarget;
    try {
      parsedTarget = parseTarget(target);
    } catch (parseErr) {
      return res.status(400).json({ 
        ok: false, 
        error: `Invalid target: ${(parseErr as Error).message}` 
      });
    }

    console.log(`[cascade-tap] Target: "${target}" → type=${parsedTarget.type}, value="${parsedTarget.value}"`);

    const startTime = Date.now();
    const fallbackChain: string[] = [];

    // ═══════════════════════════════════════════════════════════════════════════
    // UNIFIED CASCADE FOR BOTH REF AND LITERAL
    // ═══════════════════════════════════════════════════════════════════════════
    
    // For @ref: require platform
    if (parsedTarget.type === "ref" && !platform) {
      return res.status(400).json({ 
        ok: false, 
        error: "Missing platform for skill reference (@target)" 
      });
    }

    // ─── LEVEL 0: Session-learned coords (for literals only) ──────────────────
    if (parsedTarget.type === "literal") {
      const sessionCoords = getSessionLearnedCoords(parsedTarget.value, platform);
      if (sessionCoords) {
        fallbackChain.push("L0_session_coords");
        console.log(`[cascade] L0: Found session-learned coords for "${parsedTarget.value}"`);
        
        const screenWidth = 1080;
        const screenHeight = 2160;
        const pixelX = Math.round(sessionCoords.x * screenWidth);
        const pixelY = Math.round(sessionCoords.y * screenHeight);
        
        try {
          const tapJob = await dispatcherService.dispatch({
            deviceId,
            type: "tap",
            params: { x: pixelX, y: pixelY },
            timeoutMs: 30000,
          });
          sendJobToDevice(deviceId, {
            jobId: tapJob.jobId,
            type: "tap",
            params: { x: pixelX, y: pixelY },
            timeoutMs: 30000,
          });
          const tapResult = await waitForResult(tapJob.jobId, 30000);
          
          if (tapResult?.status === "completed") {
            // Verify if requested
            const verifyResult = verify 
              ? await performVerification(deviceId, verify, verifyTimeout)
              : { verified: undefined, verifyError: undefined };
            
            return res.json({
              ok: true,
              success: verify ? (verifyResult.verified ?? false) : true,
              method_used: "session_coords",
              target_type: "literal",
              target_value: parsedTarget.value,
              coords_used: sessionCoords,
              fallback_chain: fallbackChain,
              learned: false,
              learn_type: "session",
              ...verifyResult,
              latency_ms: Date.now() - startTime,
            });
          }
          fallbackChain.push("L0_tap_failed");
        } catch (err) {
          fallbackChain.push(`L0_error:${(err as Error).message.slice(0, 30)}`);
        }
      }
    }

    // ─── For LITERAL: Full cascade (ui_tree → OCR → VLM) with session learning ─
    if (parsedTarget.type === "literal") {
      // Continue with cascade levels (L0 session coords already tried above)
      const screenWidth = 1080;
      const screenHeight = 2160;
      
      // ─── L1: UI Tree search ─────────────────────────────────────────────────
      fallbackChain.push("L1_ui_tree");
      try {
        const uiJob = await dispatcherService.dispatch({
          deviceId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        sendJobToDevice(deviceId, {
          jobId: uiJob.jobId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        const uiTreeResult = await waitForResult(uiJob.jobId, 30000);
        
        if (uiTreeResult?.output?.uiTree) {
          const uiTree = typeof uiTreeResult.output.uiTree === 'string'
            ? JSON.parse(uiTreeResult.output.uiTree)
            : uiTreeResult.output.uiTree;
          
          const foundElement = findElementByText(uiTree, parsedTarget.value);
          
          if (foundElement?.bounds) {
            const bounds = foundElement.bounds;
            const centerX = (bounds.l + bounds.r) / 2;
            const centerY = (bounds.t + bounds.b) / 2;
            const normalizedCoords = { x: centerX / screenWidth, y: centerY / screenHeight };
            
            const tapSuccess = await executeTapAtCoords(deviceId, normalizedCoords, screenWidth, screenHeight);
            
            if (tapSuccess) {
              // L1 (ui_tree): save only if element is fixed in registry
              if (isElementFixed(platform, parsedTarget.value)) {
                setSessionLearnedCoords(parsedTarget.value, normalizedCoords, platform);
              }
              
              const verifyResult = verify
                ? await performVerification(deviceId, verify, verifyTimeout)
                : { verified: undefined, verifyError: undefined };
              
              return res.json({
                ok: true,
                success: verify ? (verifyResult.verified ?? false) : true,
                method_used: "ui_tree",
                target_type: "literal",
                target_value: parsedTarget.value,
                coords_used: normalizedCoords,
                fallback_chain: fallbackChain,
                learned: learn !== false,
                learn_type: "session",
                ...verifyResult,
                latency_ms: Date.now() - startTime,
              });
            }
            fallbackChain.push("L1_tap_failed");
          } else {
            fallbackChain.push("L1_not_found");
          }
        } else {
          fallbackChain.push("L1_no_tree");
        }
      } catch (err) {
        fallbackChain.push(`L1_error:${(err as Error).message.slice(0, 30)}`);
      }
      
      // ─── L2: OCR (ML Kit) ───────────────────────────────────────────────────
      fallbackChain.push("L2_ocr");
      try {
        console.log(`[cascade] L2: OCR search for "${parsedTarget.value}"`);
        const ocrJob = await dispatcherService.dispatch({
          deviceId,
          type: "ocr_find_tap",
          params: { searchText: parsedTarget.value, partialMatch: true } as unknown as OcrFindTapParams,
          timeoutMs: 30000,
        });
        sendJobToDevice(deviceId, {
          jobId: ocrJob.jobId,
          type: "ocr_find_tap",
          params: { searchText: parsedTarget.value, partialMatch: true } as unknown as OcrFindTapParams,
          timeoutMs: 30000,
        });
        const ocrResult = await waitForResult(ocrJob.jobId, 30000);
        
        if (ocrResult?.output?.found) {
          const normalizedCoords = { x: ocrResult.output.x as number, y: ocrResult.output.y as number };
          
          // NOTE: ocr_find_tap already tapped on the phone side.
          // We only need to verify/log the success, not send another tap.
          // executeTapAtCoords would cause a DOUBLE TAP since phone already tapped.
          const tapSuccess = ocrResult.output.tapped === true ? true : await executeTapAtCoords(deviceId, normalizedCoords, screenWidth, screenHeight);
          
          if (tapSuccess) {
            // L2 (OCR): save only if element is in fixed-elements registry for this app
            if (isElementFixed(platform, parsedTarget.value)) {
              setSessionLearnedCoords(parsedTarget.value, normalizedCoords, platform);
            }

            const verifyResult = verify
              ? await performVerification(deviceId, verify, verifyTimeout)
              : { verified: undefined, verifyError: undefined };
            
            return res.json({
              ok: true,
              success: verify ? (verifyResult.verified ?? false) : true,
              method_used: "ocr",
              target_type: "literal",
              target_value: parsedTarget.value,
              coords_used: normalizedCoords,
              fallback_chain: fallbackChain,
              learned: learn !== false,
              learn_type: "session",
              ...verifyResult,
              latency_ms: Date.now() - startTime,
            });
          }
          fallbackChain.push("L2_tap_failed");
        } else {
          fallbackChain.push("L2_not_found");
        }
      } catch (err) {
        fallbackChain.push(`L2_error:${(err as Error).message.slice(0, 30)}`);
      }
      
      // ─── L3: VLM (Vision) via OpenClaw CLI ────────────────────────────────────
      fallbackChain.push("L3_vlm");
      try {
        console.log(`[cascade] L3: VLM search for "${parsedTarget.value}" via OpenClaw CLI`);
        const screenshotJob = await dispatcherService.dispatch({
          deviceId,
          type: "screenshot_for_vlm",
          params: {},
          timeoutMs: 30000,
        });
        sendJobToDevice(deviceId, {
          jobId: screenshotJob.jobId,
          type: "screenshot_for_vlm",
          params: {},
          timeoutMs: 30000,
        });
        const screenshot = await waitForResult(screenshotJob.jobId, 30000);
        
        if (screenshot?.output?.image_base64) {
          // Save screenshot to file for OpenClaw CLI
          const imagePath = `/tmp/cascade_vlm_${deviceId.slice(0, 8)}_${Date.now()}.jpg`;
          const buffer = Buffer.from(screenshot.output.image_base64, "base64");
          fs.writeFileSync(imagePath, buffer);
          
          // Use OpenClaw CLI for VLM (handles OAuth tokens correctly)
          // NOTE: openclaw CLI writes JSON to stderr, not stdout!
          const prompt = `Find the UI element containing text "${parsedTarget.value}" in this screenshot. Return ONLY a JSON object with format: {"found": true, "x": <normalized_x_0_to_1>, "y": <normalized_y_0_to_1>} or {"found": false}. The coordinates should be the CENTER of the element, normalized to 0-1 range where (0,0) is top-left and (1,1) is bottom-right.`;
          
          let vlmResponse: any = null;
          try {
            const spawnResultL3 = require("child_process").spawnSync(
              "openclaw",
              ["agent", "--agent", "main", "--local", "--json", "-m", `Analyze image ${imagePath}. ${prompt}`],
              { timeout: 120000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
            );
            
            // OpenClaw CLI writes JSON to stderr; check both
            let rawJson = "";
            if ((spawnResultL3.stdout || "").includes('"payloads"')) {
              rawJson = spawnResultL3.stdout;
            } else if ((spawnResultL3.stderr || "").includes('"payloads"')) {
              const jsonStart = (spawnResultL3.stderr as string).indexOf('{');
              if (jsonStart !== -1) rawJson = (spawnResultL3.stderr as string).slice(jsonStart);
            }
            
            if (rawJson) {
              const parsed = JSON.parse(rawJson);
              const textPayload = parsed?.payloads?.[0]?.text || "";
              const jsonMatch = textPayload.match(/\{[\s\S]*?\}/) || textPayload.match(/```(?:json)?\s*([\s\S]*?)```/);
              if (jsonMatch) {
                vlmResponse = JSON.parse(jsonMatch[1] || jsonMatch[0]);
              }
            }
            console.log(`[cascade] L3: VLM response:`, JSON.stringify(vlmResponse));
          } catch (cliErr) {
            console.error(`[cascade] L3: OpenClaw CLI error:`, (cliErr as Error).message);
          } finally {
            // Cleanup temp file
            try { fs.unlinkSync(imagePath); } catch {}
          }
          
          if (vlmResponse?.found && typeof vlmResponse.x === "number" && typeof vlmResponse.y === "number") {
            const normalizedCoords = { x: vlmResponse.x, y: vlmResponse.y };
            
            const tapSuccess = await executeTapAtCoords(deviceId, normalizedCoords, screenWidth, screenHeight);
            
            if (tapSuccess) {
              // L3 (VLM): save only if element is in fixed-elements registry for this app
              if (isElementFixed(platform, parsedTarget.value)) {
                setSessionLearnedCoords(parsedTarget.value, normalizedCoords, platform);
              }

              const verifyResult = verify
                ? await performVerification(deviceId, verify, verifyTimeout)
                : { verified: undefined, verifyError: undefined };
              
              return res.json({
                ok: true,
                success: verify ? (verifyResult.verified ?? false) : true,
                method_used: "vision",
                target_type: "literal",
                target_value: parsedTarget.value,
                coords_used: normalizedCoords,
                fallback_chain: fallbackChain,
                learned: learn !== false,
                learn_type: "session",
                ...verifyResult,
                latency_ms: Date.now() - startTime,
              });
            }
            fallbackChain.push("L3_tap_failed");
          } else {
            fallbackChain.push("L3_not_found");
          }
        } else {
          fallbackChain.push("L3_no_screenshot");
        }
      } catch (err) {
        fallbackChain.push(`L3_error:${(err as Error).message.slice(0, 30)}`);
      }
      
      // All levels failed for literal
      return res.json({
        ok: true,
        success: false,
        method_used: "vision",
        target_type: "literal",
        target_value: parsedTarget.value,
        fallback_chain: fallbackChain,
        error: `All cascade levels failed for "${parsedTarget.value}"`,
        latency_ms: Date.now() - startTime,
      });
    }

    // ─── PRE-TAP: Check if we're on required screen ────────────────────────────
    const skill = await loadSkillFile(platform);
    const element = skill ? getElement(skill, parsedTarget.value) : null;
    const requiresScreen = (element as any)?.requires_screen;
    
    if (requiresScreen) {
      // Get UI tree to check current screen
      const preCheckJob = await dispatcherService.dispatch({
        deviceId,
        type: "ui_tree_dump",
        params: {},
        timeoutMs: 30000,
      });
      sendJobToDevice(deviceId, {
        jobId: preCheckJob.jobId,
        type: "ui_tree_dump",
        params: {},
        timeoutMs: 30000,
      });
      const preCheckResult = await waitForResult(preCheckJob.jobId, 30000);
      
      if (preCheckResult?.output?.uiTree) {
        const detection = await detectCurrentScreen(preCheckResult, platform);
        
        // Check for critical screens first
        if (detection.isCritical) {
          return res.json({
            ok: true,
            success: false,
            error: `Critical screen detected: ${detection.screenName}. Aborting.`,
            actualScreen: detection.screenName,
            requiredScreen: requiresScreen,
            target_type: "ref",
            target_value: parsedTarget.value,
          });
        }
        
        // Check if we're on required screen
        if (detection.screenName !== requiresScreen) {
          console.log(`[cascade-tap] Pre-check failed: required ${requiresScreen}, got ${detection.screenName}`);
          return res.json({
            ok: true,
            success: false,
            error: `Wrong screen. Required: ${requiresScreen}, current: ${detection.screenName || 'unknown'}`,
            actualScreen: detection.screenName,
            requiredScreen: requiresScreen,
            target_type: "ref",
            target_value: parsedTarget.value,
          });
        }
        
        console.log(`[cascade-tap] Pre-check passed: on ${detection.screenName}`);
      }
    }

    // ─── For @REF: Use existing cascadeTap with skill lookup ──────────────────
    const result = await cascadeTap(
      { device_id: deviceId, app: platform, element_name: parsedTarget.value },
      // UI tree provider (Level 2)
      async (devId) => {
        const job = await dispatcherService.dispatch({
          deviceId: devId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        // IMPORTANT: Send job to device via Nostr (dispatch only creates DB record)
        sendJobToDevice(devId, {
          jobId: job.jobId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        return await waitForResult(job.jobId, 30000);
      },
      // OCR provider (Level 2.5) — ML Kit text recognition
      async (devId, searchText) => {
        console.log(`[cascade] L2.5: OCR provider dispatching job for "${searchText}"`);
        const ocrJob = await dispatcherService.dispatch({
          deviceId: devId,
          type: "ocr_find_tap",
          params: { searchText, partialMatch: false } as unknown as OcrFindTapParams,
          timeoutMs: 30000,
        });
        sendJobToDevice(devId, {
          jobId: ocrJob.jobId,
          type: "ocr_find_tap",
          params: { searchText, partialMatch: false } as unknown as OcrFindTapParams,
          timeoutMs: 30000,
        });
        const result = await waitForResult(ocrJob.jobId, 30000);
        if (result?.output?.found) {
          return {
            x: result.output.x as number,
            y: result.output.y as number,
          };
        }
        return null;
      },
      // Vision provider (Level 3)
      async (devId, visualHint) => {
        const screenshotResult = await dispatcherService.dispatch({
          deviceId: devId,
          type: "screenshot_for_vlm",
          params: {},
          timeoutMs: 30000,
        });
        sendJobToDevice(devId, {
          jobId: screenshotResult.jobId,
          type: "screenshot_for_vlm",
          params: {},
          timeoutMs: 30000,
        });
        const screenshot = await waitForResult(screenshotResult.jobId, 30000);
        if (!screenshot?.output?.image_base64) return null;

        const vlmResult = await visionService.handleVisionRequest({
          jobId: screenshotResult.jobId,
          deviceId: devId,
          screenshotBase64: screenshot.output.image_base64,
          requestType: "element_find",
          actionType: "find_element",
        });

        // Parse coords from VLM response
        if (vlmResult.elements?.length > 0) {
          const el = vlmResult.elements[0];
          const screenWidth = screenshot.output.original_width || 1080;
          const screenHeight = screenshot.output.original_height || 1920;
          return {
            x: (el.bounds.x + el.bounds.width / 2) / screenWidth,
            y: (el.bounds.y + el.bounds.height / 2) / screenHeight,
          };
        }
        return null;
      },
      // Tap executor
      async (devId, coords) => {
        const screenWidth = 1080;  // TODO: get from device
        const screenHeight = 2160; // Updated for OP5T2
        const pixelX = Math.round(coords.x * screenWidth);
        const pixelY = Math.round(coords.y * screenHeight);

        try {
          const job = await dispatcherService.dispatch({
            deviceId: devId,
            type: "tap",
            params: { x: pixelX, y: pixelY },
            timeoutMs: 30000,
          });
          sendJobToDevice(devId, {
            jobId: job.jobId,
            type: "tap",
            params: { x: pixelX, y: pixelY },
            timeoutMs: 30000,
          });
          console.log(`[cascade] Tap sent: (${pixelX}, ${pixelY}) jobId=${job.jobId}`);
          const result = await waitForResult(job.jobId, 30000);
          const success = result?.status === "completed";
          console.log(`[cascade] Tap result: ${success ? 'SUCCESS' : 'FAILED'} status=${result?.status}`);
          return success;
        } catch (err) {
          console.error(`[cascade] Tap executor error:`, (err as Error).message);
          return false; // Return false on error instead of throwing
        }
      }
    );

    // ─── POST-TAP VERIFICATION using UI tree (faster than VLM) ────────────────
    let verified: boolean | undefined;
    let verifyError: string | undefined;
    let actualScreen: string | null = null;
    let recoveryAction: { action: string; reason: string } | undefined;
    
    // Always verify after tap if platform is provided (detect where we landed)
    if (result.success && platform) {
      // Wait for UI to update
      await new Promise(resolve => setTimeout(resolve, verifyTimeout));
      
      try {
        // Get fresh UI tree
        const uiJob = await dispatcherService.dispatch({
          deviceId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        sendJobToDevice(deviceId, {
          jobId: uiJob.jobId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        const uiTreeResult = await waitForResult(uiJob.jobId, 30000);
        
        if (uiTreeResult?.output?.uiTree) {
          // Detect current screen
          const detection = await detectCurrentScreen(uiTreeResult, platform);
          actualScreen = detection.screenName;
          
          // Check for critical screens (rate_limited, banned, login)
          if (detection.isCritical) {
            verified = false;
            verifyError = `Critical screen detected: ${detection.screenName}`;
            recoveryAction = determineRecoveryAction(verify || null, actualScreen, true);
          }
          // If verify param provided, check against expected screen
          else if (verify) {
            const verifyResult = await verifyScreen(uiTreeResult, platform, verify);
            verified = verifyResult.verified;
            if (!verified) {
              verifyError = verifyResult.error;
              recoveryAction = determineRecoveryAction(verify, actualScreen, false);
              
              // Execute recovery action if needed
              if (recoveryAction.action === 'back') {
                console.log(`[cascade-tap] Recovery: going back (expected ${verify}, got ${actualScreen})`);
                const backJob = await dispatcherService.dispatch({
                  deviceId,
                  type: "press_key",
                  params: { key: "back" },
                  timeoutMs: 3000,
                });
                sendJobToDevice(deviceId, {
                  jobId: backJob.jobId,
                  type: "press_key",
                  params: { key: "back" },
                  timeoutMs: 3000,
                });
                await waitForResult(backJob.jobId, 3000);
              }
            }
          } else {
            // No specific verify requested, just detect and report
            verified = true;
          }
        }
      } catch (verifyErr) {
        console.error(`[cascade-tap] Screen verification error:`, (verifyErr as Error).message);
        // Don't fail the tap just because verification errored
      }
    }

    res.json({ 
      ok: true, 
      ...result,
      target_type: "ref",
      target_value: parsedTarget.value,
      success: verify ? (result.success && (verified ?? false)) : result.success,
      learned: result.success && result.method_used !== "coords",
      learn_type: "persistent",
      verified,
      verifyError,
      actualScreen,
      recoveryAction,
    });
  } catch (err) {
    console.error("[hydra] cascade-tap error:", err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY TAP — check if we're on expected screen
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/verify-tap", async (req: Request, res: Response) => {
  try {
    const { deviceId, platform, expectedScreen } = req.body;

    if (!deviceId || !platform || !expectedScreen) {
      return res.status(400).json({ ok: false, error: "Missing deviceId, platform, or expectedScreen" });
    }

    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }

    const result = await cascadeVerify(
      { device_id: deviceId, app: platform, expected_screen: expectedScreen },
      // UI tree provider
      async (devId) => {
        const job = await dispatcherService.dispatch({
          deviceId: devId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        sendJobToDevice(devId, {
          jobId: job.jobId,
          type: "ui_tree_dump",
          params: {},
          timeoutMs: 30000,
        });
        return await waitForResult(job.jobId, 30000);
      },
      // Vision verifier
      async (devId, screen) => {
        const screenshotResult = await dispatcherService.dispatch({
          deviceId: devId,
          type: "screenshot_for_vlm",
          params: {},
          timeoutMs: 30000,
        });
        sendJobToDevice(devId, {
          jobId: screenshotResult.jobId,
          type: "screenshot_for_vlm",
          params: {},
          timeoutMs: 30000,
        });
        const screenshot = await waitForResult(screenshotResult.jobId, 30000);
        if (!screenshot?.output?.image_base64) return false;

        const verifyResult = await visionService.handleVerifyRequest(
          devId,
          screenshotResult.jobId,
          screenshot.output.image_base64,
          "screen_check",
        );
        return verifyResult.success;
      }
    );

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[hydra] verify-tap error:", err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENSHOT TO FILE — saves screenshot to file, returns ONLY path (no base64)
// Use this to avoid context overflow in Hydra
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/screenshot-to-file", async (req: Request, res: Response) => {
  try {
    const { deviceId, filePath } = req.body;

    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "Missing deviceId" });
    }

    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }

    // Default path if not provided
    const outputPath = filePath || `/tmp/hydra_screen_${deviceId.slice(0, 8)}_${Date.now()}.jpg`;

    // Get screenshot from device (internally gets base64)
    const screenshotJob = await dispatcherService.dispatch({
      deviceId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    sendJobToDevice(deviceId, {
      jobId: screenshotJob.jobId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    const screenshot = await waitForResult(screenshotJob.jobId, 30000);

    if (!screenshot?.output?.image_base64) {
      return res.status(500).json({ ok: false, error: "Failed to capture screenshot" });
    }

    // Save base64 to file
    const buffer = Buffer.from(screenshot.output.image_base64, "base64");
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, buffer);

    // Return ONLY the path, NO base64!
    res.json({
      ok: true,
      path: outputPath,
      width: screenshot.output.original_width || screenshot.output.width,
      height: screenshot.output.original_height || screenshot.output.height,
    });
  } catch (err) {
    console.error("[hydra] screenshot-to-file error:", err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYZE SCREEN — Screenshot + VLM in one call, returns ONLY JSON (no base64!)
// Uses OpenClaw agent CLI for VLM (works with OAuth tokens)
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/analyze-screen", async (req: Request, res: Response) => {
  try {
    const { deviceId, task } = req.body;

    if (!deviceId || !task) {
      return res.status(400).json({ ok: false, error: "Missing deviceId or task" });
    }

    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }

    // 1. Get screenshot from device
    const screenshotJob = await dispatcherService.dispatch({
      deviceId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    sendJobToDevice(deviceId, {
      jobId: screenshotJob.jobId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    const screenshot = await waitForResult(screenshotJob.jobId, 30000);

    if (!screenshot?.output?.image_base64) {
      return res.status(500).json({ ok: false, error: "Failed to capture screenshot" });
    }

    // 2. Save screenshot to workspace (required for OpenClaw agent access)
    const imagePath = `/data/.openclaw/workspace/hydra_vlm_${Date.now()}.jpg`;
    const buffer = Buffer.from(screenshot.output.image_base64, "base64");
    fs.writeFileSync(imagePath, buffer);

    // 2.5. Detect actual image dimensions for scaling
    // The screenshot may be scaled down (e.g., 540x1080 instead of 1080x2160)
    const sizeOf = require("image-size");
    let imageWidth = 1080, imageHeight = 2160, scaleX = 1, scaleY = 1;
    try {
      const dims = sizeOf(imagePath);
      imageWidth = dims.width || 1080;
      imageHeight = dims.height || 2160;
      const screenW = screenshot.output.original_width || 1080;
      const screenH = screenshot.output.original_height || 2160;
      scaleX = screenW / imageWidth;
      scaleY = screenH / imageHeight;
      console.log(`[hydra] Image ${imageWidth}x${imageHeight}, Screen ${screenW}x${screenH}, Scale ${scaleX}x${scaleY}`);
    } catch (e) {
      console.warn("[hydra] Could not detect image dimensions, assuming 1:1 scale");
    }

    // 3. Call OpenClaw agent CLI for VLM analysis
    // Using spawnSync instead of execSync to cleanly separate stdout from stderr
    const { spawnSync } = require("child_process");
    const prompt = `Analizează imaginea ${imagePath}. ${task} Răspunde DOAR JSON valid, fără explicații.`;
    
    let vlmResult: string = "";
    let vlmStderr: string = "";
    try {
      const spawnResult = spawnSync(
        "openclaw",
        ["agent", "--agent", "main", "--local", "--json", "-m", prompt],
        { timeout: 60000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
      );
      const rawStdout = spawnResult.stdout || "";
      vlmStderr = spawnResult.stderr || "";
      
      // NOTE: OpenClaw CLI writes JSON output to stderr (not stdout).
      // We check stdout first for forward compatibility, then fall back to stderr.
      if (rawStdout.includes('"payloads"')) {
        vlmResult = rawStdout;
        console.log("[hydra] VLM: JSON found in stdout");
      } else if (vlmStderr.includes('"payloads"')) {
        // Extract the JSON object starting at the first '{' in stderr
        const jsonStart = vlmStderr.indexOf('{');
        if (jsonStart !== -1) {
          vlmResult = vlmStderr.slice(jsonStart);
          console.log("[hydra] VLM: JSON found in stderr (expected behavior for openclaw CLI)");
        }
      }
      
      console.log("[hydra] VLM result length:", vlmResult?.length);
      console.log("[hydra] VLM result preview:", vlmResult?.slice(0, 300));
      
      if (spawnResult.error) {
        throw spawnResult.error;
      }
    } catch (execErr: any) {
      // Clean up image file
      try { fs.unlinkSync(imagePath); } catch {}
      return res.status(500).json({ ok: false, error: `VLM call failed: ${execErr.message}` });
    }

    // 4. Clean up image file
    try { fs.unlinkSync(imagePath); } catch {}

    // 5. Parse VLM response
    let analysis: any = {};
    try {
      if (!vlmResult || vlmResult.trim() === "") {
        console.error("[hydra] VLM returned empty JSON. Full stderr:", vlmStderr.slice(0, 800));
        analysis = { raw: "", error: "VLM returned empty response" };
      } else {
        const parsed = JSON.parse(vlmResult);
        const textPayload = parsed?.payloads?.[0]?.text || "";
        
        console.log("[hydra] textPayload length:", textPayload?.length);
        console.log("[hydra] textPayload preview:", textPayload?.slice(0, 200));
        
        // Extract JSON from markdown code blocks if present
        const jsonMatch = textPayload.match(/```(?:json)?\s*([\s\S]*?)```/) || 
                          textPayload.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            analysis = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          } catch {
            // JSON parse failed on extracted match — use text directly
            analysis = { raw: textPayload, is_potential_client: false };
          }
        } else {
          // VLM returned plain text (no JSON) — use it as-is
          analysis = { raw: textPayload, is_potential_client: false };
        }
      }
    } catch (parseErr) {
      console.error("[hydra] Failed to parse VLM JSON envelope:", (parseErr as Error).message);
      console.error("[hydra] Raw vlmResult:", vlmResult?.slice(0, 500));
      analysis = { raw: vlmResult };
    }

    // Return clean JSON - NO base64 anywhere!
    // Include scale factors so Hydra knows to multiply VLM coordinates
    res.json({
      ok: true,
      analysis,
      screenWidth: screenshot.output.original_width || 1080,
      screenHeight: screenshot.output.original_height || 2160,
      imageWidth,
      imageHeight,
      scaleX,
      scaleY,
      // WARNING for Hydra: VLM coords are in image space, multiply by scaleX/scaleY for screen coords!
      coordsWarning: scaleX > 1 ? `VLM coordinates are in ${imageWidth}x${imageHeight} space. Multiply by ${scaleX} for real screen coordinates!` : null,
    });
  } catch (err) {
    console.error("[hydra] analyze-screen error:", err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VLM ANALYZE — generic VLM call with screenshot (DEPRECATED - use analyze-screen)
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/vlm/analyze", async (req: Request, res: Response) => {
  try {
    const { deviceId, requestType, actionType } = req.body;

    if (!deviceId || !requestType) {
      return res.status(400).json({ ok: false, error: "Missing deviceId or requestType" });
    }

    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }

    // Get screenshot from device
    const screenshotJob = await dispatcherService.dispatch({
      deviceId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    const screenshot = await waitForResult(screenshotJob.jobId, 30000);

    if (!screenshot?.output?.image_base64) {
      return res.status(500).json({ ok: false, error: "Failed to capture screenshot" });
    }

    // Send to VLM
    const vlmResult = await visionService.handleVisionRequest({
      jobId: screenshotJob.jobId,
      deviceId,
      screenshotBase64: screenshot.output.image_base64,
      requestType: requestType as any,
      actionType: actionType || "default",
    });

    res.json({ ok: true, ...vlmResult });
  } catch (err) {
    console.error("[hydra] vlm/analyze error:", err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VLM EVALUATE PROFILE — Instagram profile analysis
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/vlm/evaluate-profile", async (req: Request, res: Response) => {
  try {
    const { deviceId, criteria } = req.body;

    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "Missing deviceId" });
    }

    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }

    // Get screenshot
    const screenshotJob = await dispatcherService.dispatch({
      deviceId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    const screenshot = await waitForResult(screenshotJob.jobId, 30000);

    if (!screenshot?.output?.image_base64) {
      return res.status(500).json({ ok: false, error: "Failed to capture screenshot" });
    }

    // Evaluate profile via VLM
    const vlmResult = await visionService.handleVisionRequest({
      jobId: screenshotJob.jobId,
      deviceId,
      screenshotBase64: screenshot.output.image_base64,
      requestType: "screen_understand",
      actionType: "evaluate_profile",
    });

    res.json({ ok: true, ...vlmResult, criteria_matched: evaluateCriteria(vlmResult, criteria) });
  } catch (err) {
    console.error("[hydra] vlm/evaluate-profile error:", err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VLM DETECT BLOCK — check for soft block/rate limit
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/vlm/detect-block", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "Missing deviceId" });
    }

    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }

    // Get screenshot
    const screenshotJob = await dispatcherService.dispatch({
      deviceId,
      type: "screenshot_for_vlm",
      params: {},
      timeoutMs: 30000,
    });
    const screenshot = await waitForResult(screenshotJob.jobId, 30000);

    if (!screenshot?.output?.image_base64) {
      return res.status(500).json({ ok: false, error: "Failed to capture screenshot" });
    }

    // Detect block via VLM
    const vlmResult = await visionService.handleVisionRequest({
      jobId: screenshotJob.jobId,
      deviceId,
      screenshotBase64: screenshot.output.image_base64,
      requestType: "screen_understand",
      actionType: "detect_block",
    });

    res.json({ ok: true, ...vlmResult });
  } catch (err) {
    console.error("[hydra] vlm/detect-block error:", err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKPOINT CRUD
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/checkpoint/save", async (req: Request, res: Response) => {
  try {
    const { sessionId, taskId, deviceId, accountId, phase, state } = req.body;
    await checkpointService.save(sessionId, taskId, deviceId, accountId, phase, state);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get("/checkpoint/load", async (req: Request, res: Response) => {
  try {
    const { taskId, deviceId } = req.query;
    const checkpoint = await checkpointService.load(taskId as string, deviceId as string);
    res.json({ ok: true, checkpoint });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.delete("/checkpoint/clear", async (req: Request, res: Response) => {
  try {
    const { taskId, deviceId } = req.body;
    await checkpointService.clear(taskId, deviceId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUSTDESK ENABLE — Start screen sharing service and extract ID + password
// ═══════════════════════════════════════════════════════════════════════════════

const RUSTDESK_PACKAGE = "com.carriez.flutter_hbb";

/**
 * Helper: Find element by contentDescription OR text in UI tree
 * Returns bounds center coordinates if found
 */
function findElementInUiTree(
  node: UIElement,
  options: { contentDescription?: string; text?: string; textContains?: string }
): { x: number; y: number } | null {
  if (!node) return null;
  
  function search(n: UIElement): UIElement | null {
    if (!n) return null;
    
    const nodeDesc = n.desc || "";
    const nodeText = n.text || "";
    
    // Match by contentDescription (exact)
    if (options.contentDescription && nodeDesc === options.contentDescription) {
      return n;
    }
    
    // Match by text (exact)
    if (options.text && nodeText === options.text) {
      return n;
    }
    
    // Match by text contains
    if (options.textContains && nodeText.includes(options.textContains)) {
      return n;
    }
    
    // Recurse into children
    if (n.children && Array.isArray(n.children)) {
      for (const child of n.children) {
        const found = search(child);
        if (found) return found;
      }
    }
    
    return null;
  }
  
  const found = search(node);
  if (found?.bounds) {
    const centerX = (found.bounds.l + found.bounds.r) / 2;
    const centerY = (found.bounds.t + found.bounds.b) / 2;
    return { x: centerX, y: centerY };
  }
  return null;
}

/**
 * Helper: Check if RustDesk service is already running
 * Returns { running: boolean, id?: string, password?: string }
 * 
 * UI tree text format when running:
 *   'Your device\nID\n1 134 065 636\nOne-time password\nrq5apy\n...'
 *   contentDescription/text contains "Stop service"
 */
function checkRustDeskStatus(uiTree: UIElement): { 
  running: boolean; 
  id?: string; 
  password?: string;
} {
  let hasStopService = false;
  let id: string | undefined;
  let password: string | undefined;
  
  function traverse(n: UIElement) {
    if (!n) return;
    
    const text = n.text || "";
    const desc = n.contentDescription || n.desc || "";
    
    // Check for Stop service button (means service is running)
    // contentDescription or text contains "Stop service"
    if (desc.includes("Stop service") || text.includes("Stop service")) {
      hasStopService = true;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Parse ID and password from multiline text block
    // Format: 'Your device\nID\n1 134 065 636\nOne-time password\nrq5apy\n...'
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Try to extract ID from multiline text containing "\nID\n"
    // ID format: X XXX XXX XXX (1 digit, space, 3 digits, space, 3 digits, space, 3 digits)
    if (text.includes("\\nID\\n") || text.includes("\nID\n")) {
      // Parse ID: look for pattern after "ID\n" - format: "X XXX XXX XXX"
      const idMatch = text.match(/ID\\n(\d\s\d{3}\s\d{3}\s\d{3})/) || 
                      text.match(/ID\n(\d\s\d{3}\s\d{3}\s\d{3})/);
      if (idMatch) {
        // Remove all spaces: "1 134 065 636" -> "1134065636"
        id = idMatch[1].replace(/\s/g, "");
      }
      
      // Parse password: look for pattern after "One-time password\n" - 6 alphanumeric chars
      const pwMatch = text.match(/One-time password\\n([a-z0-9]{6})/i) ||
                      text.match(/One-time password\n([a-z0-9]{6})/i);
      if (pwMatch) {
        password = pwMatch[1];
      }
    }
    
    // Fallback: Also check for direct matches (in case UI tree has separate nodes)
    // ID: pattern X XXX XXX XXX directly in a node's text
    if (!id) {
      const directIdMatch = text.match(/^(\d)\s(\d{3})\s(\d{3})\s(\d{3})$/);
      if (directIdMatch) {
        id = directIdMatch[1] + directIdMatch[2] + directIdMatch[3] + directIdMatch[4];
      }
    }
    
    // Password: 6-char alphanumeric that's not pure numeric and not a known UI label
    if (!password && text.match(/^[a-z0-9]{6}$/i) && !text.match(/^\d+$/)) {
      password = text;
    }
    
    // Recurse into children
    if (n.children && Array.isArray(n.children)) {
      for (const child of n.children) {
        traverse(child);
      }
    }
  }
  
  traverse(uiTree);
  
  // Running = has Stop service button (Ready is optional, Stop service is definitive)
  return {
    running: hasStopService,
    id,
    password,
  };
}

router.post("/rustdesk/enable", async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "Missing deviceId" });
    }
    
    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }
    
    console.log(`[rustdesk] Starting enable flow for device ${deviceId.slice(0, 8)}...`);
    
    // Helper to dispatch job and wait
    async function dispatchAndWait(
      type: string,
      params: Record<string, unknown>,
      timeoutMs: number
    ): Promise<any> {
      const job = await dispatcherService.dispatch({
        deviceId,
        type: type as any,
        params,
        timeoutMs,
      });
      // Register waiter BEFORE sending — result can arrive before await
      const resultPromise = waitForResult(job.jobId, timeoutMs);
      sendJobToDevice(deviceId, {
        jobId: job.jobId,
        type: type as any,
        params,
        timeoutMs,
      });
      return await resultPromise;
    }
    
    // Helper to get UI tree
    async function getUiTree(): Promise<UIElement | null> {
      const result = await dispatchAndWait("ui_tree_dump", {}, 30000);
      if (result?.output?.uiTree) {
        return typeof result.output.uiTree === "string"
          ? JSON.parse(result.output.uiTree)
          : result.output.uiTree;
      }
      return null;
    }
    
    // Helper to tap by finding element
    async function tapElement(
      options: { contentDescription?: string; text?: string },
      screenWidth = 1080,
      screenHeight = 2160
    ): Promise<boolean> {
      const uiTree = await getUiTree();
      if (!uiTree) return false;
      
      const coords = findElementInUiTree(uiTree, options);
      if (!coords) return false;
      
      const result = await dispatchAndWait("tap", { x: coords.x, y: coords.y }, 30000);
      return result?.status === "completed";
    }
    
    // Helper to tap with a11y_find_tap (more reliable for accessibility-labeled elements)
    async function a11yFindTap(
      searchText: string,
      useContentDescription = true,
      partialMatch = false
    ): Promise<boolean> {
      const params: Record<string, unknown> = useContentDescription
        ? { contentDescription: searchText, partialMatch }
        : { text: searchText, partialMatch };
      
      const result = await dispatchAndWait("a11y_find_tap", params, 30000);
      return result?.status === "completed" && result?.output?.found !== false;
    }
    
    // ─── PREAMBLE: Wake + Unlock if on lockscreen ──────────────────────────────
    console.log(`[rustdesk] Preamble: Checking screen state...`);
    const preambleTree = await getUiTree();
    const isLockscreen = preambleTree?.packageName === "com.android.systemui";
    
    if (isLockscreen) {
      console.log(`[rustdesk] Preamble: Device on lockscreen — waking + unlocking`);
      
      // screen_wake
      await dispatchAndWait("screen_wake", {}, 30000);
      
      // unlock
      await dispatchAndWait("unlock", {}, 30000);
      
      // wait for unlock animation
      await new Promise(r => setTimeout(r, 500));
      console.log(`[rustdesk] Preamble: Wake + unlock complete`);
    } else {
      console.log(`[rustdesk] Preamble: Screen already active (pkg=${preambleTree?.packageName || "unknown"})`);
    }
    
    // ─── STEP 1: Open RustDesk app (skip if already in foreground) ─────────────
    console.log(`[rustdesk] Step 1: Checking if RustDesk already open...`);
    
    // Check if RustDesk is already the foreground app
    const preOpenTree = await getUiTree();
    const rustdeskAlreadyOpen = preOpenTree?.packageName === RUSTDESK_PACKAGE;
    
    if (rustdeskAlreadyOpen) {
      console.log(`[rustdesk] Step 1: RustDesk already in foreground, skipping open_app`);
    } else {
      console.log(`[rustdesk] Step 1: Opening app ${RUSTDESK_PACKAGE}`);
      const openResult = await dispatchAndWait("open_app", { packageName: RUSTDESK_PACKAGE }, 30000);
      if (openResult?.status !== "completed") {
        return res.status(500).json({ ok: false, error: "Failed to open RustDesk app" });
      }
      
      // Wait for app to load
      await new Promise(r => setTimeout(r, 3000));
    }
    
    // ─── STEP 2: Navigate to "Share screen" tab ────────────────────────────────
    // Note: contentDescription is "Share screen\nTab 3 of 4", so we use partialMatch
    console.log(`[rustdesk] Step 2: Navigating to Share screen tab`);
    const shareScreenTapped = await a11yFindTap("Share screen", true, true);
    if (!shareScreenTapped) {
      console.warn(`[rustdesk] Could not find Share screen tab via a11y, trying fixed coords (Tab 3: 675, 1960)`);
      // Fallback: tap fixed coordinates for Tab 3 on 1080x2160 screen
      await dispatchAndWait("tap", { x: 675, y: 1960 }, 30000);
    }
    await new Promise(r => setTimeout(r, 2000));
    
    // ─── STEP 3: Check current status ──────────────────────────────────────────
    console.log(`[rustdesk] Step 3: Checking current status`);
    let uiTree = await getUiTree();
    if (!uiTree) {
      return res.status(500).json({ ok: false, error: "Failed to get UI tree" });
    }
    
    let status = checkRustDeskStatus(uiTree);
    
    // If already running, return immediately
    if (status.running) {
      console.log(`[rustdesk] Service already running`);
      return res.json({
        ok: true,
        data: {
          status: "running",
        },
        latency_ms: Date.now() - startTime,
      });
    }
    
    // ─── STEP 4: Start service ─────────────────────────────────────────────────
    console.log(`[rustdesk] Step 4: Starting service`);
    const startTapped = await a11yFindTap("Start service");
    if (!startTapped) {
      // Try text-based tap as fallback
      await tapElement({ text: "Start service" });
    }
    await new Promise(r => setTimeout(r, 2000));
    
    // ─── STEP 5: Handle "I Agree" warning dialog ───────────────────────────────
    console.log(`[rustdesk] Step 5: Handling warning dialog (I Agree)`);
    const agreeTapped = await a11yFindTap("I Agree");
    if (agreeTapped) {
      console.log(`[rustdesk] Tapped I Agree`);
      await new Promise(r => setTimeout(r, 2000));
    }
    
    // ─── STEP 6: Handle screen capture permission dialog (OK) ──────────────────
    console.log(`[rustdesk] Step 6: Handling screen capture dialog (OK)`);
    const okTapped = await a11yFindTap("OK");
    if (okTapped) {
      console.log(`[rustdesk] Tapped OK`);
      await new Promise(r => setTimeout(r, 2000));
    }
    
    // ─── STEP 7: Handle system dialog (START NOW) ──────────────────────────────
    // This dialog comes from com.android.systemui, uses text= not contentDescription
    console.log(`[rustdesk] Step 7: Handling system dialog (START NOW)`);
    const startNowTapped = await a11yFindTap("START NOW", false); // text-based
    if (!startNowTapped) {
      // Also try "Start now" (different capitalization)
      await a11yFindTap("Start now", false);
    }
    await new Promise(r => setTimeout(r, 3000));
    
    // ─── STEP 8: Verify service started and extract ID/password ────────────────
    console.log(`[rustdesk] Step 8: Verifying service status and extracting credentials`);
    
    // Retry a few times as UI may take time to update
    for (let attempt = 0; attempt < 3; attempt++) {
      uiTree = await getUiTree();
      if (uiTree) {
        status = checkRustDeskStatus(uiTree);
        if (status.running) {
          break;
        }
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    
    if (!status.running) {
      // Try to click "Start service" one more time if we didn't catch the dialogs
      console.log(`[rustdesk] Service not running, retrying Start service tap`);
      await a11yFindTap("Start service");
      await new Promise(r => setTimeout(r, 3000));
      
      // Final check
      uiTree = await getUiTree();
      if (uiTree) {
        status = checkRustDeskStatus(uiTree);
      }
    }
    
    // Success = "Stop service" found in UI (means RustDesk is active)
    if (status.running) {
      console.log(`[rustdesk] Success! Service is running (Stop service found in UI)`);
      return res.json({
        ok: true,
        data: {
          status: "running",
        },
        latency_ms: Date.now() - startTime,
      });
    }
    
    // Service not running
    return res.status(500).json({
      ok: false,
      error: "Service did not start - 'Stop service' button not found in UI",
      latency_ms: Date.now() - startTime,
    });
    
  } catch (err) {
    console.error("[rustdesk] Enable error:", err);
    return res.status(500).json({ 
      ok: false, 
      error: (err as Error).message,
      latency_ms: Date.now() - startTime,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUSTDESK ENABLE (CASCADE-TAP VERSION)
// Same flow as /rustdesk/enable but uses cascade-tap for fixed elements
// Cascade-tap persists coords to DB via coordCacheService (L0 cache)
// ════════════════════════════════════════════════════════════════════════════════

router.post("/rustdesk/enable-cascade", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const cascadeTapBase = `http://localhost:${process.env.PORT || 3000}`;
  
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "Missing deviceId" });
    }
    
    if (!isDeviceOnline(deviceId)) {
      return res.status(503).json({ ok: false, error: "Device not connected" });
    }
    
    console.log(`[rustdesk-cascade] Starting enable flow for device ${deviceId.slice(0, 8)}...`);
    
    // Helper to dispatch job and wait
    async function dispatchAndWait(
      type: string,
      params: Record<string, unknown>,
      timeoutMs: number
    ): Promise<any> {
      const job = await dispatcherService.dispatch({
        deviceId,
        type: type as any,
        params,
        timeoutMs,
      });
      const resultPromise = waitForResult(job.jobId, timeoutMs);
      sendJobToDevice(deviceId, {
        jobId: job.jobId,
        type: type as any,
        params,
        timeoutMs,
      });
      return await resultPromise;
    }
    
    // Helper: cascade-tap via internal HTTP call + persist to DB
    async function cascadeTap(elementName: string, platform = "rustdesk"): Promise<any> {
      const response = await fetch(`${cascadeTapBase}/api/hydra/cascade-tap`, {
        method: "POST",
        headers: {
          "X-Api-Key": process.env.API_KEY || "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId,
          platform,
          target: elementName, // literal text — cascade-tap handles detection
        }),
      });
      const result = await response.json() as {
        success?: boolean;
        coords_used?: { x: number; y: number };
        method_used?: string;
      };
      
      // Debug logging
      console.log(`[rustdesk-cascade] cascadeTap "${elementName}" result:`, JSON.stringify(result));
      const isFixed = isElementFixed(platform, elementName);
      console.log(`[rustdesk-cascade] isElementFixed("${platform}", "${elementName}") = ${isFixed}`);
      
      // Persist to DB if successful and coords were used
      if (result?.success && result?.coords_used && isFixed) {
        try {
          await coordCacheService.learnCoord({
            deviceInfo: {
              app: platform,
              appVersion: "1.0",
              resolution: "1080x2160",
              deviceClass: "phone",
              orientation: "portrait",
              fontScaleBucket: "normal",
            },
            screenType: "rustdesk",
            elementName,
            x: result.coords_used.x,
            y: result.coords_used.y,
            width: 0,
            height: 0,
            confidence: 1.0,
            learnMethod: (result.method_used as "ui_tree" | "ocr" | "vlm" | "manual") || "cascade",
          });
          console.log(`[rustdesk-cascade] Persisted ${elementName} (${result.method_used}) to DB`);
        } catch (err) {
          console.warn(`[rustdesk-cascade] Failed to persist ${elementName}:`, (err as Error).message);
        }
      } else {
        console.log(`[rustdesk-cascade] Skipping DB persist for "${elementName}": success=${result?.success}, coords=${!!result?.coords_used}, fixed=${isFixed}`);
      }
      
      return result;
    }
    
    // Helper to get UI tree
    async function getUiTree(): Promise<UIElement | null> {
      const result = await dispatchAndWait("ui_tree_dump", {}, 30000);
      if (result?.output?.uiTree) {
        return typeof result.output.uiTree === "string"
          ? JSON.parse(result.output.uiTree)
          : result.output.uiTree;
      }
      return null;
    }
    
    // ─── PREAMBLE: Wake + Unlock if on lockscreen ──────────────────────────────
    console.log(`[rustdesk-cascade] Preamble: Checking screen state...`);
    const preambleTree = await getUiTree();
    const isLockscreen = preambleTree?.packageName === "com.android.systemui";
    
    if (isLockscreen) {
      console.log(`[rustdesk-cascade] Preamble: Device on lockscreen — waking + unlocking`);
      await dispatchAndWait("screen_wake", {}, 30000);
      await dispatchAndWait("unlock", {}, 30000);
      await new Promise(r => setTimeout(r, 500));
      console.log(`[rustdesk-cascade] Preamble: Wake + unlock complete`);
    } else {
      console.log(`[rustdesk-cascade] Preamble: Screen already active (pkg=${preambleTree?.packageName || "unknown"})`);
    }
    
    // ─── STEP 1: Open RustDesk app ─────────────────────────────────────────────
    console.log(`[rustdesk-cascade] Step 1: Checking if RustDesk already open...`);
    const preOpenTree = await getUiTree();
    const rustdeskAlreadyOpen = preOpenTree?.packageName === RUSTDESK_PACKAGE;
    
    if (!rustdeskAlreadyOpen) {
      console.log(`[rustdesk-cascade] Step 1: Opening app ${RUSTDESK_PACKAGE}`);
      const openResult = await dispatchAndWait("open_app", { packageName: RUSTDESK_PACKAGE }, 30000);
      if (openResult?.status !== "completed") {
        return res.status(500).json({ ok: false, error: "Failed to open RustDesk app" });
      }
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log(`[rustdesk-cascade] Step 1: RustDesk already in foreground`);
    }
    
    // ─── STEP 1.5: Check if service is already running ──────────────────────────
    // IMPORTANT: Skip all taps if RustDesk is already active — tapping "Share screen"
    // again when already on that tab would TOGGLE IT OFF and stop the service!
    console.log(`[rustdesk-cascade] Step 1.5: Checking if service is already running...`);
    const preCheckTree = await getUiTree();
    if (preCheckTree) {
      const preStatus = checkRustDeskStatus(preCheckTree);
      if (preStatus.running) {
        console.log(`[rustdesk-cascade] Service already running! Skipping all taps, returning success.`);
        return res.json({
          ok: true,
          data: { status: "running", id: preStatus.id, password: preStatus.password },
          latency_ms: Date.now() - startTime,
        });
      }
    }
    
    // ─── STEP 2: Navigate to "Share screen" tab via cascade-tap ────────────────
    console.log(`[rustdesk-cascade] Step 2: Cascade-tap "Share screen"`);
    const shareResult = await cascadeTap("Share screen");
    console.log(`[rustdesk-cascade] Share screen:`, JSON.stringify(shareResult));
    await new Promise(r => setTimeout(r, 2000));
    
    // ─── STEP 3: Check current status ──────────────────────────────────────────
    console.log(`[rustdesk-cascade] Step 3: Checking current status`);
    let uiTree = await getUiTree();
    if (!uiTree) {
      return res.status(500).json({ ok: false, error: "Failed to get UI tree" });
    }
    
    let status = checkRustDeskStatus(uiTree);
    if (status.running) {
      console.log(`[rustdesk-cascade] Service already running`);
      return res.json({
        ok: true,
        data: { status: "running" },
        latency_ms: Date.now() - startTime,
      });
    }
    
    // ─── STEP 4: Start service via cascade-tap ──────────────────────────────────
    console.log(`[rustdesk-cascade] Step 4: Cascade-tap "Start service"`);
    const startResult = await cascadeTap("Start service");
    console.log(`[rustdesk-cascade] Start service:`, JSON.stringify(startResult));
    await new Promise(r => setTimeout(r, 2000));
    
    // ─── STEP 5: Handle "I Agree" warning dialog via cascade-tap ───────────────
    console.log(`[rustdesk-cascade] Step 5: Cascade-tap "I Agree"`);
    const agreeResult = await cascadeTap("I Agree");
    console.log(`[rustdesk-cascade] I Agree:`, JSON.stringify(agreeResult));
    await new Promise(r => setTimeout(r, 2000));
    
    // ─── STEP 6: Handle screen capture permission (OK) via cascade-tap ─────────
    console.log(`[rustdesk-cascade] Step 6: Cascade-tap "OK"`);
    const okResult = await cascadeTap("OK");
    console.log(`[rustdesk-cascade] OK:`, JSON.stringify(okResult));
    await new Promise(r => setTimeout(r, 2000));
    
    // ─── STEP 7: Handle system dialog (START NOW) via cascade-tap ───────────────
    console.log(`[rustdesk-cascade] Step 7: Cascade-tap "START NOW"`);
    const startNowResult = await cascadeTap("START NOW");
    console.log(`[rustdesk-cascade] START NOW:`, JSON.stringify(startNowResult));
    await new Promise(r => setTimeout(r, 3000));
    
    // ─── STEP 8: Verify service started ─────────────────────────────────────────
    console.log(`[rustdesk-cascade] Step 8: Verifying service status`);
    
    for (let attempt = 0; attempt < 3; attempt++) {
      uiTree = await getUiTree();
      if (uiTree) {
        status = checkRustDeskStatus(uiTree);
        if (status.running) break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    
    if (!status.running) {
      // Retry Start service one more time
      console.log(`[rustdesk-cascade] Service not running, retrying Start service`);
      await cascadeTap("Start service");
      await new Promise(r => setTimeout(r, 3000));
      
      uiTree = await getUiTree();
      if (uiTree) status = checkRustDeskStatus(uiTree);
    }
    
    if (status.running) {
      console.log(`[rustdesk-cascade] Success! Service is running`);
      return res.json({
        ok: true,
        data: { status: "running", id: status.id, password: status.password },
        latency_ms: Date.now() - startTime,
      });
    }
    
    return res.status(500).json({
      ok: false,
      error: "Service did not start - 'Stop service' button not found in UI",
      latency_ms: Date.now() - startTime,
    });
    
  } catch (err) {
    console.error("[rustdesk-cascade] Enable error:", err);
    return res.status(500).json({ 
      ok: false, 
      error: (err as Error).message,
      latency_ms: Date.now() - startTime,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════════════════════
// SESSION LEARNING CLEAR (dev/testing)
// ═══════════════════════════════════════════════════════════════════════════════
router.delete("/session-learning/clear", async (req: Request, res: Response) => {
    const { clearSessionLearning } = await import("../modules/skills/target-parser");
    clearSessionLearning();
    res.json({ ok: true, message: "Session learning cleared" });
});

// RAW TAP: tap at normalized coords (0.0-1.0) — bypasses cascade/session coords entirely
// Body: { deviceId: string, x: number (0-1), y: number (0-1) }
router.post("/tap-raw", async (req: Request, res: Response) => {
    const { deviceId, x, y } = req.body as { deviceId: string; x: number; y: number };
    if (!deviceId || x === undefined || y === undefined) {
        res.status(400).json({ ok: false, error: "deviceId, x, y required (normalized 0-1)" });
        return;
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
        res.status(400).json({ ok: false, error: "x and y must be between 0 and 1" });
        return;
    }
    try {
        const job = await dispatcherService.dispatch({
            deviceId,
            type: "tap",
            params: { x, y },
            timeoutMs: 15000,
        });
        sendJobToDevice(deviceId, {
            jobId: job.jobId,
            type: "tap",
            params: { x, y },
            timeoutMs: 15000,
        });
        res.json({ ok: true, jobId: job.jobId });
    } catch (err: any) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

function evaluateCriteria(vlmResult: any, criteria?: Record<string, any>): boolean {
  if (!criteria) return true;
  // Simple criteria evaluation — extend as needed
  const parsed = vlmResult.elements?.[0] || {};
  if (criteria.min_followers && parsed.followers_approx < criteria.min_followers) return false;
  if (criteria.require_active && !parsed.is_active) return false;
  if (criteria.require_public && parsed.is_private) return false;
  return true;
}

export default router;
