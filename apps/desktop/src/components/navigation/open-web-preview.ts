import { createContext } from "react";

export const OpenWebPreview = createContext<((url: string) => void) | null>(null);
