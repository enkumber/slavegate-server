/**
 * skill.actions.test.ts
 * Unit tests for evalConditionExpr and criteria matching logic.
 * Run: npx vitest run src/modules/skills/skill.actions.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { evalConditionExpr, executeSkillAction, type SkillActionContext } from './skill.actions';
import { llmComplete } from '../../utils/llm';

vi.mock('../../utils/llm', () => ({
  llmComplete: vi.fn(),
}));

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

describe('semantic_tap', () => {
  function context(uiTree: Record<string, unknown>): SkillActionContext {
    const dispatchAndWait = vi.fn()
      .mockResolvedValueOnce({
        status: 'completed',
        output: { uiTree: JSON.stringify(uiTree) },
        durationMs: 25,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        output: { tapped: true },
        durationMs: 10,
      });

    return {
      workflowId: 'wf-semantic',
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
      dispatchAndWait,
      cascadeTap: vi.fn(),
      executeSteps: vi.fn(),
      persistCheckpoint: vi.fn(),
      sleep: vi.fn(),
    };
  }

  it('resolves Reddit first visible post comments from live ui tree and taps normalized center', async () => {
    const uiTree = {
      bounds: { left: 0, top: 0, right: 1080, bottom: 2160 },
      children: [
        {
          resourceId: 'feed_lazy_column',
          bounds: { left: 0, top: 220, right: 1080, bottom: 2160 },
          children: [
            {
              resourceId: 'post_unit',
              contentDescription: 'From brasov, Posted 2 hours ago, Bar with rock, 1 upvote, 10 comments, 0 awards',
              visible: true,
              bounds: { left: 0, top: 326, right: 1080, bottom: 646 },
            },
          ],
        },
      ],
    };
    const ctx = context(uiTree);

    await executeSkillAction('semantic_tap', {
      target: 'reddit.first_visible_post.open_comments',
      waitMs: 0,
    }, ctx);

    expect(ctx.dispatchAndWait).toHaveBeenNthCalledWith(1, 'ui_tree_dump', {}, 15_000);
    expect(ctx.dispatchAndWait).toHaveBeenNthCalledWith(2, 'tap', {
      x: 0.5,
      y: 486 / 2160,
    }, 15_000);
    expect(ctx.checkpoint.variables._last_semantic_tap).toMatchObject({
      target: 'reddit.first_visible_post.open_comments',
      matchedText: expect.stringContaining('10 comments'),
      bounds: { left: 0, top: 326, right: 1080, bottom: 646 },
    });
  });

  it('keeps Reddit first visible post comments taps above bottom navigation for partially visible cards', async () => {
    const uiTree = {
      bounds: { left: 0, top: 0, right: 1080, bottom: 2160 },
      children: [
        {
          resourceId: 'feed_lazy_column',
          bounds: { left: 0, top: 220, right: 1080, bottom: 2160 },
          children: [
            {
              resourceId: '',
              contentDescription: 'From Gullible-Usual-7952, Posted 23 days ago, The Temple of Poseidon, Image gallery, 1295 upvotes, 32 comments, Shared 123 times',
              visible: true,
              bounds: { left: 0, top: 1378, right: 1080, bottom: 2534 },
            },
          ],
        },
      ],
    };
    const ctx = context(uiTree);

    await executeSkillAction('semantic_tap', {
      target: 'reddit.first_visible_post.open_comments',
      waitMs: 0,
    }, ctx);

    expect(ctx.dispatchAndWait).toHaveBeenNthCalledWith(2, 'tap', {
      x: 0.5,
      y: expect.closeTo(1574.6 / 2160, 5),
    }, 15_000);
    expect(ctx.checkpoint.variables._last_semantic_tap).toMatchObject({
      target: 'reddit.first_visible_post.open_comments',
      matchedText: expect.stringContaining('32 comments'),
      bounds: { left: 0, top: 1378, right: 1080, bottom: 2534 },
    });
  });

  it('prefers the visible Reddit comments button over the post body when opening comments', async () => {
    const uiTree = {
      bounds: { left: 0, top: 0, right: 1080, bottom: 2160 },
      children: [
        {
          resourceId: 'post_unit',
          contentDescription: 'From FilmmakingintheSouth, Posted 20 days ago, Milos, most beautiful place on Earth, 607 upvotes, 42 comments, Shared 96 times',
          visible: true,
          bounds: { left: 0, top: 1378, right: 1080, bottom: 2193 },
          children: [
            {
              resourceId: 'actionBar_comment_button',
              visible: true,
              bounds: { left: 377, top: 1897, right: 577, bottom: 2002 },
              children: [
                {
                  resourceId: 'actionBar_comment_icon',
                  contentDescription: '42 comments',
                  visible: true,
                  bounds: { left: 419, top: 1923, right: 472, bottom: 1976 },
                },
              ],
            },
          ],
        },
      ],
    };
    const ctx = context(uiTree);

    await executeSkillAction('semantic_tap', {
      target: 'reddit.first_visible_post.open_comments',
      waitMs: 0,
    }, ctx);

    expect(ctx.dispatchAndWait).toHaveBeenNthCalledWith(2, 'tap', {
      x: expect.closeTo(477 / 1080, 5),
      y: expect.closeTo(1949.5 / 2160, 5),
    }, 15_000);
    expect(ctx.checkpoint.variables._last_semantic_tap).toMatchObject({
      matchedText: '42 comments',
      bounds: { left: 377, top: 1897, right: 577, bottom: 2002 },
    });
  });
});

describe('vlm_generate_comment', () => {
  function context(): SkillActionContext {
    return {
      workflowId: 'wf-comment',
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

  it('generates a comment from captured Reddit UI context through llmComplete', async () => {
    vi.mocked(llmComplete).mockResolvedValueOnce('"Milos looks absolutely magical from that description."');
    const ctx = context();
    ctx.checkpoint.variables._postContextUiTree = {
      uiTree: JSON.stringify({
        bounds: { left: 0, top: 0, right: 1080, bottom: 2160 },
        children: [
          { contentDescription: 'Post title, Milos, most beautiful place on Earth', visible: true },
          { contentDescription: 'Post body, I try to go to Milos once a year to visit Kleftiko on a boat tour.', visible: true },
          { contentDescription: '42 comments', visible: true },
        ],
      }),
    };

    await executeSkillAction('vlm_generate_comment', {
      post_description_var: '_postContextUiTree',
      target_variable: '_generated_comment',
      max_chars: 120,
    }, ctx);

    expect(llmComplete).toHaveBeenCalledWith(
      expect.stringContaining('Milos, most beautiful place on Earth'),
      undefined,
      expect.objectContaining({ disableThinking: true, max_tokens: 96 }),
    );
    expect(ctx.checkpoint.variables._generated_comment).toBe('Milos looks absolutely magical from that description.');
    expect(ctx.checkpoint.variables.vlm_calls_this_run).toBe(1);
  });

  it('fails instead of silently continuing when no post context is available', async () => {
    const ctx = context();
    await expect(executeSkillAction('vlm_generate_comment', {
      post_description_var: '_missing',
      target_variable: '_generated_comment',
    }, ctx)).rejects.toThrow('no post description available');
    expect(ctx.checkpoint.variables._generated_comment).toBeUndefined();
  });
});

describe('classify_reddit_health_scan', () => {
  function context(uiTree: string): SkillActionContext {
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
      dispatchAndWait: vi.fn().mockResolvedValue({
        status: 'completed',
        output: { uiTree },
      }),
      cascadeTap: vi.fn(),
      executeSteps: vi.fn(),
      persistCheckpoint: vi.fn(),
      sleep: vi.fn(),
    };
  }

  it('materializes Reddit health output fields from a local UI tree', async () => {
    const ctx = context('packageName=com.reddit.frontpage text="Find anything" text="Home" text="Create" text="Inbox" text="u/Consistent-Beyond386"');

    await executeSkillAction('classify_reddit_health_scan', {}, ctx);

    expect(ctx.dispatchAndWait).toHaveBeenCalledWith('ui_tree_dump', {}, 10_000);
    expect(ctx.checkpoint.variables).toMatchObject({
      loggedIn: 'true',
      homeFeedVisible: 'true',
      searchSurfaceAvailable: 'true',
      challengeDetected: 'false',
      loginWallDetected: 'false',
      accountSwitcherVisible: 'false',
      observedUsername: 'Consistent-Beyond386',
      screenState: 'reddit_home_feed',
      error: '',
    });
  });

  it('marks login wall when Reddit asks for authentication', async () => {
    const ctx = context('packageName=com.reddit.frontpage text="Log in" text="Continue with Google" text="Sign up"');

    await executeSkillAction('classify_reddit_health_scan', {}, ctx);

    expect(ctx.checkpoint.variables).toMatchObject({
      loggedIn: 'false',
      loginWallDetected: 'true',
      screenState: 'reddit_unknown',
    });
  });
});
