import type { ConnectorActionKind } from "@fable/protocol";
import { prepareConnectorAction } from "./shared";

export function prepareLinearAction(
  action: Extract<ConnectorActionKind, "linear.create-issue" | "linear.update-issue" | "linear.comment">,
  payload: Record<string, string>
) {
  return prepareConnectorAction(
    "linear",
    "Linear",
    action,
    payload,
    "medium",
    "Creates or changes the identified Linear issue after explicit approval."
  );
}
