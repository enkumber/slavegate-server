# Device-exclusive execution

All Android UI execution is admitted through `DeviceExecutionLeaseService`; `DirectWsServer.sendJob`, `sendBatch`, and `sendWorkflowStart` require an internally issued, identity-checked lease context. Public callers cannot select a fencing token. The existing synchronous boolean job-dispatch response is preserved: contention returns the existing not-sent/busy behavior.

Each device has one active owner and a monotonically increasing fence. The durable schema records owner/run, ingress, request/idempotency keys, attempt, lifecycle timestamps, cancellation metadata, and a FIFO queue. Startup expires prior active ownership before any transport admission. Matching owner/token reentry and bounded disconnect recovery are supported; expired tokens are never reused. Result handlers validate owner/token/currentness and discard late results.

Lock order is device lease first, then workflow/batch/job resources. Code holding a device lease must not await acquisition of a second device lease.

Non-execution DirectWS traffic is deliberately exempt: authentication, ping/pong, heartbeat, acknowledgements, model/config/template updates, LLM request/results, workflow cancellation, and OTA package notification/status. These messages maintain connection/control state and do not directly invoke Android UI execution. `JOB`, `BATCH_START`, `WORKFLOW_START`, and legacy `EXECUTE_TASK` are never exempt.
