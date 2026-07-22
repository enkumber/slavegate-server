-- Runtime-editable policy for the human workflow compiler.
-- Navigation choices belong in PostgreSQL, not in the server prompt code.

INSERT INTO system_prompts (key, content)
VALUES (
  'human_workflow_compiler_policy',
  $policy$
Compilation policy:
- For navigation to an absolute http:// or https:// URL, prefer one intent_send action with android.intent.action.VIEW, the target package supplied by runtime data, and the URL as uri. Do not edit a browser address bar with tap/type_text/press_key when intent_send expresses the goal.
- A condition step must provide check or expression and a non-empty if_true step array. Add if_false only when the goal needs it.
- Keep safetyClass consistent with every generated action. type_text and set_focused_text are mutations and must not appear in read_only workflows.
$policy$
)
ON CONFLICT (key) DO NOTHING;
