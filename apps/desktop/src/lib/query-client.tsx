import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useState } from "react";

export function createFableQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 10_000,
        gcTime: 5 * 60_000
      },
      mutations: {
        networkMode: "always",
        retry: 0
      }
    }
  });
}

export function FableQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createFableQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
