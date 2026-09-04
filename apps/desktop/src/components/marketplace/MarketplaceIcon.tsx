import { Atom } from "@phosphor-icons/react/dist/csr/Atom";
import { BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { Buildings } from "@phosphor-icons/react/dist/csr/Buildings";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { ChatsCircle } from "@phosphor-icons/react/dist/csr/ChatsCircle";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { CodaLogo } from "@phosphor-icons/react/dist/csr/CodaLogo";
import { CreditCard } from "@phosphor-icons/react/dist/csr/CreditCard";
import { Cube } from "@phosphor-icons/react/dist/csr/Cube";
import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { DropboxLogo } from "@phosphor-icons/react/dist/csr/DropboxLogo";
import { FigmaLogo } from "@phosphor-icons/react/dist/csr/FigmaLogo";
import { FlowArrow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { GitlabLogo } from "@phosphor-icons/react/dist/csr/GitlabLogo";
import { GoogleLogo } from "@phosphor-icons/react/dist/csr/GoogleLogo";
import { GridFour } from "@phosphor-icons/react/dist/csr/GridFour";
import { Headset } from "@phosphor-icons/react/dist/csr/Headset";
import { InstagramLogo } from "@phosphor-icons/react/dist/csr/InstagramLogo";
import { Kanban } from "@phosphor-icons/react/dist/csr/Kanban";
import { LinkedinLogo } from "@phosphor-icons/react/dist/csr/LinkedinLogo";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { Megaphone } from "@phosphor-icons/react/dist/csr/Megaphone";
import { MetaLogo } from "@phosphor-icons/react/dist/csr/MetaLogo";
import { MicrosoftOutlookLogo } from "@phosphor-icons/react/dist/csr/MicrosoftOutlookLogo";
import { MicrosoftTeamsLogo } from "@phosphor-icons/react/dist/csr/MicrosoftTeamsLogo";
import { Palette } from "@phosphor-icons/react/dist/csr/Palette";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ShoppingBag } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { Signature } from "@phosphor-icons/react/dist/csr/Signature";
import { Storefront } from "@phosphor-icons/react/dist/csr/Storefront";
import { Target } from "@phosphor-icons/react/dist/csr/Target";
import { UserCircleGear } from "@phosphor-icons/react/dist/csr/UserCircleGear";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { YoutubeLogo } from "@phosphor-icons/react/dist/csr/YoutubeLogo";
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

  const iconProps = { size, weight: "regular" as const, "aria-hidden": true };
  switch (icon) {
    case "airtable":
      return <GridFour {...iconProps} />;
    case "analytics":
      return <ChartBar {...iconProps} />;
    case "automation":
      return <FlowArrow {...iconProps} />;
    case "box":
      return <Cube {...iconProps} />;
    case "calendar":
      return <MicrosoftOutlookLogo {...iconProps} />;
    case "canva":
      return <Palette {...iconProps} />;
    case "cloud":
      return <Cloud {...iconProps} />;
    case "coda":
      return <CodaLogo {...iconProps} />;
    case "commerce":
      return <Storefront {...iconProps} />;
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
    case "dropbox":
      return <DropboxLogo {...iconProps} />;
    case "figma":
      return <FigmaLogo {...iconProps} />;
    case "finance":
      return <CreditCard {...iconProps} />;
    case "gitlab":
      return <GitlabLogo {...iconProps} />;
    case "google":
      return <GoogleLogo {...iconProps} />;
    case "instagram":
      return <InstagramLogo {...iconProps} />;
    case "learning":
      return <BookOpen {...iconProps} />;
    case "legal":
      return <Gavel {...iconProps} />;
    case "linkedin":
      return <LinkedinLogo {...iconProps} />;
    case "marketing":
      return <Megaphone {...iconProps} />;
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
    case "research":
      return <Atom {...iconProps} />;
    case "sales":
      return <Target {...iconProps} />;
    case "security":
      return <LockKey {...iconProps} />;
    case "support":
      return <Headset {...iconProps} />;
    case "youtube":
      return <YoutubeLogo {...iconProps} />;
    default:
      return <ShoppingBag {...iconProps} />;
  }
}
