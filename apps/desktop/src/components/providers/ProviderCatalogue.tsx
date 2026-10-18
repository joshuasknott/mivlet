import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BackendProvider, BackendVerifyResult } from "@mivlet/protocol";
import { ProviderIcon } from "../ProviderIcon";
import { ProviderConnectionFlow } from "./ProviderConnectionFlow";
import {
  buildProviderFamilies,
  isProviderConnected,
} from "./provider-catalogue-data";

export {
  buildProviderFamilies,
  encodeCustomProviderSecret,
} from "./provider-catalogue-data";

export interface ProviderCatalogueProps {
  onboarding?: boolean;
  providers: BackendProvider[];
  connectedBackendIds: string[];
  onConnect: (
    providerId: string,
    secret: string,
  ) => Promise<BackendVerifyResult>;
  onDisconnect?: (providerId: string) => void | Promise<void>;
  onRefreshModels?: (providerId: string) => void | Promise<void>;
  onCheckConnection?: (
    providerId: string,
  ) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  onStatus?: (message: string) => void;
}
export function ProviderCatalogue({
  onboarding = false,
  providers,
  connectedBackendIds,
  onConnect,
  onDisconnect,
  onRefreshModels,
  onCheckConnection,
  onStartBrowserLogin,
  onStatus,
}: ProviderCatalogueProps) {
  const families = useMemo(
    () =>
      buildProviderFamilies(providers).filter(
        (family) => !["custom", "siliconflow", "together"].includes(family.id),
      ),
    [providers],
  );
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const lastProvider = useRef<string | null>(null);
  const catalogueRef = useRef<HTMLDivElement>(null);
  const selectedFamily = families.find(
    (family) => family.id === selectedFamilyId,
  );
  const filtered = families.filter((family) =>
    [family.label, ...family.aliases].some((value) =>
      value.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  const initialCount = onboarding ? 9 : 6;
  const preferred = [
    "openai",
    "anthropic",
    "antigravity",
    "deepseek",
    "openrouter",
    "mistral",
    "groq",
    "moonshot",
    "zai",
  ];
  const ordered = onboarding
    ? [...filtered].sort((a, b) => {
        const rank = (id: string) =>
          preferred.includes(id) ? preferred.indexOf(id) : preferred.length;
        return rank(a.id) - rank(b.id);
      })
    : filtered;
  const visible =
    query.trim() || showAll ? ordered : ordered.slice(0, initialCount);
  const connectedCount = families.filter((family) =>
    family.providers.some((provider) =>
      isProviderConnected(provider, connectedBackendIds),
    ),
  ).length;
  useLayoutEffect(() => {
    if (!selectedFamilyId && lastProvider.current) {
      catalogueRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-provider-family-id="${lastProvider.current}"]`,
        )
        ?.focus();
    }
  }, [selectedFamilyId]);

  return (
    <div
      className={`provider-catalogue${onboarding ? " provider-catalogue--onboarding" : ""}`}
      ref={catalogueRef}
    >
      {selectedFamily ? (
        <ProviderConnectionFlow
          key={selectedFamily.id}
          onboarding={onboarding}
          family={selectedFamily}
          connectedBackendIds={connectedBackendIds}
          onClose={() => setSelectedFamilyId(null)}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onRefreshModels={onRefreshModels}
          onCheckConnection={onCheckConnection}
          onStartBrowserLogin={onStartBrowserLogin}
          onStatus={onStatus}
        />
      ) : (
        <>
          <header className="provider-catalogue__header">
            <h2>{onboarding ? "Choose your AI" : "Providers"}</h2>
            {!onboarding && <p>Connect the AI you want to work with.</p>}
          </header>
          {!onboarding && (
            <p className="provider-catalogue__status">
              {connectedCount
                ? `${connectedCount} ${connectedCount === 1 ? "provider" : "providers"} connected`
                : "No providers connected"}
            </p>
          )}
          {(!onboarding || showAll) && (
            <label className="provider-catalogue__search">
              <MagnifyingGlass size={20} aria-hidden="true" />
              <input
                type="search"
                aria-label="Find a provider"
                placeholder="Find a provider"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          <div className="provider-catalogue__list" aria-label="All providers">
            {visible.map((family) => {
              const connected = family.providers.some((provider) =>
                isProviderConnected(provider, connectedBackendIds),
              );
              const hasAccount = family.methods.some(
                (method) => method.kind === "oauth-browser",
              );
              const hasKey = family.methods.some(
                (method) => method.kind === "api-key",
              );
              const summary =
                hasAccount && hasKey
                  ? "Account or API key"
                  : hasAccount
                    ? "Account sign-in"
                    : hasKey
                      ? "API key"
                      : "Local connection";
              return (
                <button
                  key={family.id}
                  type="button"
                  className="provider-catalogue-item"
                  data-provider-family-id={family.id}
                  aria-label={
                    connected ? `${family.label}, Connected` : family.label
                  }
                  onClick={() => {
                    lastProvider.current = family.id;
                    setSelectedFamilyId(family.id);
                  }}
                >
                  <span
                    className="provider-catalogue-item__logo"
                    aria-hidden="true"
                  >
                    <ProviderIcon
                      provider={family.iconProvider}
                      size={onboarding ? 54 : 30}
                    />
                  </span>
                  <span className="provider-catalogue-item__text">
                    <strong>{family.label}</strong>
                    {!onboarding && <small>{summary}</small>}
                  </span>
                  {connected ? (
                    <small className="provider-catalogue-item__connected">
                      Connected
                    </small>
                  ) : null}
                  {!onboarding && <CaretRight size={18} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          {!filtered.length ? (
            <p role="status">
              {families.length
                ? "No providers match your search."
                : "No model providers are registered in this build."}
            </p>
          ) : null}
          {!query.trim() && families.length > initialCount ? (
            <button
              className="provider-catalogue__more"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll
                ? "Show fewer providers"
                : onboarding
                  ? "More providers"
                  : "Show all providers"}
            </button>
          ) : null}
          {!onboarding && (
            <p className="provider-security-note">
              <LockKey size={18} aria-hidden="true" />
              Your credentials stay on this device.
            </p>
          )}
        </>
      )}
    </div>
  );
}
