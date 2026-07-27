export type WorkflowEventSource = string;
export type WorkflowEventType = string;
export type WorkflowExecutionMode = string;

export interface WorkflowEvent {
  type: "workflow_event";
  eventId: string;
  eventType: WorkflowEventType;
  event: WorkflowEventType;
  timestamp: string;
  occurredAt: string;
  workflowId?: string;
  workflowRunId?: string;
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
