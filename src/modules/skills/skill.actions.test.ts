/**
 * skill.actions.test.ts
 * Unit tests for evalConditionExpr and criteria matching logic.
 * Run: npx vitest run src/modules/skills/skill.actions.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { evalConditionExpr, executeSkillAction, type SkillActionContext } from './skill.actions';

describe('evalConditionExpr', () => {
  const vars: Record<string, unknown> = {
    unfollowed_count:         10,
    evaluated_count:          7,
    consecutive_empty_scrolls: 3,
    stopped_reason:           null,
    input: {
      count: 50,
    },
    some_string: 'list_exhausted',
    _flag:       true,
    _falsy:      false,
  };

  // Numeric comparisons
  it('>=  true',  () => expect(evalConditionExpr('unfollowed_count >= 10',  vars)).toBe(true));
  it('>=  false', () => expect(evalConditionExpr('unfollowed_count >= 11',  vars)).toBe(false));
  it('>   true',  () => expect(evalConditionExpr('evaluated_count > 5',     vars)).toBe(true));
  it('<   true',  () => expect(evalConditionExpr('unfollowed_count < 50',   vars)).toBe(true));
  it('<=  true',  () => expect(evalConditionExpr('unfollowed_count <= 10',  vars)).toBe(true));
  it('==  true',  () => expect(evalConditionExpr('unfollowed_count == 10',  vars)).toBe(true));
  it('!=  true',  () => expect(evalConditionExpr('unfollowed_count != 99',  vars)).toBe(true));

  // Dot notation
  it('dot notation', () => expect(evalConditionExpr('input.count >= 50', vars)).toBe(true));

  // Exit conditions from smart_unfollow.skill
  it('unfollowed_count >= input.count',            () => expect(evalConditionExpr('unfollowed_count >= input.count', vars)).toBe(false));
  it('consecutive_empty_scrolls >= 3',             () => expect(evalConditionExpr('consecutive_empty_scrolls >= 3', vars)).toBe(true));

  // is set / is not set
  it('null is not set',     () => expect(evalConditionExpr('stopped_reason is not set', vars)).toBe(true));
  it('number is set',       () => expect(evalConditionExpr('unfollowed_count is set',   vars)).toBe(true));
  it('missing is not set',  () => expect(evalConditionExpr('no_such_var is not set',    vars)).toBe(true));

  // String comparison
  it("string == 'value'", () => expect(evalConditionExpr("some_string == 'list_exhausted'", vars)).toBe(true));
  it("string != 'other'", () => expect(evalConditionExpr("some_string != 'other'",          vars)).toBe(true));

  // Boolean literals and truthy check
  it('true literal',  () => expect(evalConditionExpr('true',    vars)).toBe(true));
  it('false literal', () => expect(evalConditionExpr('false',   vars)).toBe(false));
  it('truthy var',    () => expect(evalConditionExpr('_flag',   vars)).toBe(true));
  it('falsy var',     () => expect(evalConditionExpr('_falsy',  vars)).toBe(false));
});

describe('set_variable', () => {
  function context(): SkillActionContext {
    return {
      workflowId: 'wf-test',
      deviceId: 'device-test',
      platform: 'reddit',
      checkpoint: {
        stepIndex: 0,
        loopStack: [],
        variables: {},
        hbeParams: {},
        checkpointAt: new Date().toISOString(),
      },
      stepIndex: 0,
      dispatchAndWait: vi.fn(),
      cascadeTap: vi.fn(),
      executeSteps: vi.fn(),
      persistCheckpoint: vi.fn(),
      sleep: vi.fn(),
    };
  }

  it('sets a single key/value pair', async () => {
    const ctx = context();

    await executeSkillAction('set_variable', { key: 'loggedIn', value: 'unknown' }, ctx);

    expect(ctx.checkpoint.variables.loggedIn).toBe('unknown');
  });

  it('sets a map of canonical output variables', async () => {
    const ctx = context();

    await executeSkillAction('set_variable', {
      variables: {
        loggedIn: 'unknown',
        homeFeedVisible: 'unknown',
        searchSurfaceAvailable: 'unknown',
        challengeDetected: 'false',
        loginWallDetected: 'false',
        accountSwitcherVisible: 'unknown',
        observedUsername: null,
        error: null,
      },
    }, ctx);

    expect(ctx.checkpoint.variables).toMatchObject({
      loggedIn: 'unknown',
      homeFeedVisible: 'unknown',
      searchSurfaceAvailable: 'unknown',
      challengeDetected: 'false',
      loginWallDetected: 'false',
      accountSwitcherVisible: 'unknown',
      observedUsername: null,
      error: null,
    });
  });

  it('rejects empty set_variable params', async () => {
    await expect(executeSkillAction('set_variable', {}, context())).rejects.toThrow(
      'set_variable requires key/value or variables map',
    );
  });
});
