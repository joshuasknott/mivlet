import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";

export type McpApprovalOwner = {
  workspaceId: string;
  conversationId: string;
  resultId: string;
  generation: number;
};

export function mcpAppPanelId(owner: McpApprovalOwner) {
  return `mcp-app:${owner.workspaceId}:${owner.conversationId}:${owner.resultId}:${owner.generation}`;
}

export function useMcpAppApprovalTarget(
  owners: ReadonlyMap<string, McpApprovalOwner>,
) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const findTarget = () => {
      const next = Array.from(
        document.querySelectorAll<HTMLElement>("[data-mcp-app-panel]"),
      ).find((candidate) =>
        !candidate.closest("[hidden]") && [...owners.values()].some(
          (owner) => candidate.dataset.mcpAppPanel === mcpAppPanelId(owner),
        ),
      );
      setTarget((current) => (current === next ? current : next ?? null));
    };
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, [owners]);
  return target?.isConnected && !target.closest("[hidden]") ? target : null;
}

/**
 * Keeps MCP approvals beside their owning docked app while reusing the
 * conversation's canonical approval card and decision callbacks.
 */
export function McpAppApprovalPortal({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return target?.isConnected ? createPortal(children, target) : null;
}
