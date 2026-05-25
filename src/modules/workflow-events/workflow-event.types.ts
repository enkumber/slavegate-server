export type WorkflowEventSource =
  | "task_runner"
  | "workflow_compiler"
  | "edge_device"
  | "workflow_executor"
  | "agency";

export type WorkflowEventType =
  | "queued"
  | "started"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "batch_started"
  | "batch_completed"
  | "batch_failed"
  | "recovery_started"
  | "recovery_succeeded"
  | "recovery_failed"
  | "checkpoint_updated"
  | "completed"
  | "failed"
  | "cancelled"
  | "dispatch_accepted"
  | "dispatch_queued"
  | "dispatch_running"
  | "task_running"
  | "task_completed"
  | "task_failed"
  | "workflow_started"
  | "workflow_status"
  | "workflow_completed"
  | "workflow_failed"
  | "recovery_attempt"
  | "recovery_result";

export type WorkflowExecutionMode = "edge" | "server";

export interface WorkflowEvent {
  type: "workflow_event";
  eventId: string;
  eventType: WorkflowEventType;
  event: WorkflowEventType;
  timestamp: string;
  occurredAt: string;
  workflowId?: string;
  taskId?: string;
  agencyWorkflowRunId?: string;
  clientId?: string;
  accountId?: string;
  deviceId?: string;
  source: WorkflowEventSource;
  mode?: WorkflowExecutionMode;
  status?: string;
  /** Completed step count in [0,totalSteps]. Edge WORKFLOW_STATUS currentStep is normalized into this field. */
  currentStep?: number;
  totalSteps?: number;
  stepId?: string;
  /** Zero-based index for the step currently executing or the step that produced this event. */
  stepIndex?: number;
  message?: string;
  errorCode?: string;
  error?: string;
  counters?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export type WorkflowEventInput = Omit<
  WorkflowEvent,
  "type" | "eventId" | "event" | "eventType" | "timestamp" | "occurredAt" | "details"
> & {
  eventId?: string;
  event?: WorkflowEventType;
  eventType?: WorkflowEventType;
  timestamp?: string;
  occurredAt?: string;
  details?: Record<string, unknown>;
};

export type WorkflowEventSubscriber = (event: WorkflowEvent) => void;
