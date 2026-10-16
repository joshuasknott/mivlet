import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type {
  AutomationEventDraft,
  EventAutomationInput,
  EventDelivery,
  EventIngressStatus,
  EventTemplatePreview,
} from "@mivlet/protocol/domains/event-automations";
import type { LocalSchedule } from "./local-schedules";

async function invoke<T>(command: string, request: object): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview")
    throw new Error("Event automations require the installed desktop app.");
  try {
    return await adapter.invoke<T>(command, { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export const saveEventTrigger = (
  request: EventAutomationInput & {
    signingKeyId: string;
    expectedRevision?: number;
    rotateEndpoint?: boolean;
  },
) => invoke<LocalSchedule>("event_trigger_save", request);

export const previewEventTemplate = (request: {
  event: AutomationEventDraft;
  prompt: string;
  sampleJson: string;
}) => invoke<EventTemplatePreview>("event_template_preview", request);

export const listEventDeliveries = (workspaceId: string, scheduleId: string) =>
  invoke<EventDelivery[]>("event_delivery_list", { workspaceId, scheduleId });

export const getEventIngress = (workspaceId: string) =>
  invoke<EventIngressStatus>("event_ingress_status", { workspaceId });
export const restoreEventIngress = (workspaceId: string) =>
  invoke<EventIngressStatus>("event_ingress_restore", { workspaceId });
export const configureEventIngress = (request: {
  workspaceId: string;
  enabled: boolean;
  port: number;
}) => invoke<EventIngressStatus>("event_ingress_configure", request);
