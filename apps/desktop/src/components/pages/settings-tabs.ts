/**
 * Eager-loadable settings tab metadata, kept separate from the heavy
 * `SettingsPage` module so the settings modal's nav/search list can render
 * without pulling the full page (and its transitive deps) into the initial
 * bundle. `SettingsPage` itself is loaded lazily.
 */
export type SettingsTab = "general" | "providers" | "connections" | "privacy";

export const tabs: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "connections", label: "Tool servers" },
  { id: "privacy", label: "Privacy & data" }
];
