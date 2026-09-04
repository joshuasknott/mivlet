import { BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { Buildings } from "@phosphor-icons/react/dist/csr/Buildings";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { ChatsCircle } from "@phosphor-icons/react/dist/csr/ChatsCircle";
import { CreditCard } from "@phosphor-icons/react/dist/csr/CreditCard";
import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { Headset } from "@phosphor-icons/react/dist/csr/Headset";
import { Kanban } from "@phosphor-icons/react/dist/csr/Kanban";
import { LinkedinLogo } from "@phosphor-icons/react/dist/csr/LinkedinLogo";
import { MetaLogo } from "@phosphor-icons/react/dist/csr/MetaLogo";
import { MicrosoftOutlookLogo } from "@phosphor-icons/react/dist/csr/MicrosoftOutlookLogo";
import { MicrosoftTeamsLogo } from "@phosphor-icons/react/dist/csr/MicrosoftTeamsLogo";
import { Palette } from "@phosphor-icons/react/dist/csr/Palette";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ShoppingBag } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { Signature } from "@phosphor-icons/react/dist/csr/Signature";
import { Target } from "@phosphor-icons/react/dist/csr/Target";
import { UserCircleGear } from "@phosphor-icons/react/dist/csr/UserCircleGear";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { connectorLogos } from "./connector-logos";
import { ConnectorIcon } from "../ConnectorIcon";
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
  icon: MarketplaceIconName;
  size?: number;
}) {
  if (LIVE_CONNECTOR_IDS.has(id)) {
    return <ConnectorIcon id={id} />;
  }

  if (connectorLogos[id]) return <img src={connectorLogos[id]} width={size} height={size} loading="lazy" decoding="async" alt="" aria-hidden="true" />;

  const iconProps = { size, weight: "regular" as const, "aria-hidden": true };
  switch (icon) {
    case "analytics":
      return <ChartBar {...iconProps} />;
    case "canva":
      return <Palette {...iconProps} />;
    case "communication":
      return <ChatsCircle {...iconProps} />;
    case "compliance":
      return <ShieldCheck {...iconProps} />;
    case "crm":
      return <Buildings {...iconProps} />;
    case "data":
      return <Database {...iconProps} />;
    case "docusign":
      return <Signature {...iconProps} />;
    case "finance":
      return <CreditCard {...iconProps} />;
    case "learning":
      return <BookOpen {...iconProps} />;
    case "legal":
      return <Gavel {...iconProps} />;
    case "linkedin":
      return <LinkedinLogo {...iconProps} />;
    case "meta":
      return <MetaLogo {...iconProps} />;
    case "microsoft-outlook":
      return <MicrosoftOutlookLogo {...iconProps} />;
    case "microsoft-teams":
      return <MicrosoftTeamsLogo {...iconProps} />;
    case "operations":
      return <Wrench {...iconProps} />;
    case "people":
      return <UserCircleGear {...iconProps} />;
    case "product":
      return <Kanban {...iconProps} />;
    case "sales":
      return <Target {...iconProps} />;
    case "support":
      return <Headset {...iconProps} />;
    default:
      return <ShoppingBag {...iconProps} />;
  }
}
