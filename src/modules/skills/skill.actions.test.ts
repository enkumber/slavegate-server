/**
 * skill.actions.test.ts
 * Unit tests for evalConditionExpr and criteria matching logic.
 * Run: npx vitest run src/modules/skills/skill.actions.test.ts
 */

import { describe, it, expect } from 'vitest';
import { evalConditionExpr } from './skill.actions';

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
