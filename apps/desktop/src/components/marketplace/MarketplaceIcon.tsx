import { ChatsCircle } from "@phosphor-icons/react/dist/csr/ChatsCircle";
import { CreditCard } from "@phosphor-icons/react/dist/csr/CreditCard";
import { Kanban } from "@phosphor-icons/react/dist/csr/Kanban";
import { Palette } from "@phosphor-icons/react/dist/csr/Palette";
import { ShoppingBag } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { UserCircleGear } from "@phosphor-icons/react/dist/csr/UserCircleGear";
import { connectorLogos } from "./connector-logos";
import { ConnectorIcon } from "../ConnectorIcon";
import { builtinPluginEntries } from "../../lib/builtin-plugins";
import type { MarketplaceIconName } from "./marketplace-catalog";

const LIVE_CONNECTOR_IDS = new Set([
  "github",
  "vercel",
  "google-drive",
  "notion",
  "gmail",
  "slack",
  "google-calendar",
  "linear",
]);

export function MarketplaceIcon({
  id,
  icon,
  size = 26,
}: {
  id: string;
  icon?: MarketplaceIconName;
  size?: number;
}) {
  const builtin = builtinPluginEntries.find((entry) => entry.id === id);
  if (builtin) return <img src={builtin.icon} width={size} height={size} loading="lazy" decoding="async" alt="" aria-hidden="true" />;

  if (LIVE_CONNECTOR_IDS.has(id)) {
    return <ConnectorIcon id={id} />;
  }

  if (connectorLogos[id]) return <img src={connectorLogos[id]} width={size} height={size} loading="lazy" decoding="async" alt="" aria-hidden="true" />;

  switch (icon) {
    case "canva":
      return <Palette size={size} weight="regular" aria-hidden="true" />;
    case "communication":
      return <ChatsCircle size={size} weight="regular" aria-hidden="true" />;
    case "finance":
      return <CreditCard size={size} weight="regular" aria-hidden="true" />;
    case "people":
      return <UserCircleGear size={size} weight="regular" aria-hidden="true" />;
    case "product":
      return <Kanban size={size} weight="regular" aria-hidden="true" />;
    default:
      return <ShoppingBag size={size} weight="regular" aria-hidden="true" />;
  }
}
